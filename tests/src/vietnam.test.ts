import { describe, expect, test } from "vitest";
import { AiState } from "../../server/src/game/ai/aiController.ts";
import { hasLineOfSight, ricochetRisk } from "../../server/src/game/ai/perception.ts";
import { avoidObstacles } from "../../server/src/game/ai/steering.ts";
import { collider } from "../../shared/utils/collider.ts";
import { ObjectType } from "../../shared/net/objectSerializeFns.ts";
import type { Game } from "../../server/src/game/game.ts";
import type { Player } from "../../server/src/game/objects/player.ts";
import {
    type AiArchetype,
    AiDefs,
    isAiArchetype,
} from "../../shared/defs/gameObjects/aiDefs.ts";
import { MeleeDefs } from "../../shared/defs/gameObjects/meleeDefs.ts";
import { MapDefs } from "../../shared/defs/mapDefs.ts";
import { GameObjectDefs, MapObjectDefs } from "../../shared/defs/register.ts";
import { GameConfig, TeamMode } from "../../shared/gameConfig.ts";
import { v2, type Vec2 } from "../../shared/utils/v2.ts";
import { Config } from "../../server/src/config.ts";
import { createGame } from "./gameTestHelpers.ts";
import "./testHelpers.ts";

/**
 * Simulation tests step a whole game tens of thousands of times, which is well
 * past vitest's five-second default. Exceeding it fails as a timeout rather than
 * as an assertion, which is a confusing way to find out a test got slower.
 */
const SIM_TIMEOUT = 30_000;

/**
 * Put a human somewhere legal and an AI a few metres away with clear line of
 * sight, retrying angles because the Vietnam map is deliberately dense enough
 * that a random bearing is often blocked by a real tree.
 */
function placeFacingPair(
    game: Game,
    archetype: AiArchetype,
    distance: number,
): { human: Player; ai: Player } | undefined {
    // Several candidate origins, each swept for a clear bearing. Map generation
    // is random, so a single origin can legitimately be walled in on all sides.
    for (let origin = 0; origin < 12; origin++) {
        const humanPos = game.map.getSpawnPos();

        for (let step = 0; step < 24; step++) {
            const angle = (step / 24) * Math.PI * 2;
            const aiPos = v2.add(
                humanPos,
                v2.create(Math.cos(angle) * distance, Math.sin(angle) * distance),
            );

            if (!game.map.canPlayerSpawn(aiPos)) continue;
            if (!hasLineOfSight(game, humanPos, aiPos, 0)) continue;

            const human = game.playerBarn.addTestPlayer({ pos: humanPos });
            if (!game.aiBarn.spawn(archetype, aiPos)) return undefined;

            const ai = game.aiBarn.controllers.at(-1)!.player;
            return { human, ai };
        }
    }
    return undefined;
}

describe("Vietnam mode definitions", () => {
    test("every disguise in the pool is a real costume outfit", () => {
        const pool = MapDefs.vietnam.gameMode.ai!.disguisePool;
        expect(Object.keys(pool).length).toBeGreaterThan(3);

        for (const name of Object.keys(pool)) {
            const outfit = GameObjectDefs.typeToDefSafe(name);
            expect(outfit, `${name} must exist`).toBeDefined();
            expect(
                outfit && "obstacleType" in outfit && outfit.obstacleType,
                `${name} must have an obstacleType, or the disguise does nothing`,
            ).toBeTruthy();
        }
    });

    test("nothing an AI carries renders a sprite while it is disguised", () => {
        // The melee slot is what a dormant AI holds so no gun barrel shows. Every
        // melee weapon except fists draws its own world sprite, which would poke
        // out of the foliage and give the disguise away from across the map.
        const melee = MeleeDefs.fists;
        expect(melee.type).toBe("melee");
        expect(
            (melee as { worldImg?: unknown }).worldImg,
            "fists must stay the sprite-less option",
        ).toBeUndefined();
    });

    test("archetype loot tiers exist on the vietnam map", () => {
        const lootTable = MapDefs.vietnam.lootTable;
        for (const [name, def] of Object.entries(AiDefs)) {
            for (const entry of def.loot) {
                expect(lootTable[entry.tier], `${name} drops ${entry.tier}`).toBeDefined();
            }
        }
    });

    test("map spawn weights only reference real archetypes", () => {
        const ai = MapDefs.vietnam.gameMode.ai!;
        expect(ai.enabled).toBe(true);
        for (const key of Object.keys(ai.archetypeWeights)) {
            expect(isAiArchetype(key), `${key} is not an archetype`).toBe(true);
        }
        expect(isAiArchetype(ai.boss!.archetype)).toBe(true);
    });

    test("display names render in the game's font", () => {
        // The killfeed uses a bitmap font with no Vietnamese diacritics, so
        // archetype names must stay inside plain ASCII.
        for (const [name, def] of Object.entries(AiDefs)) {
            expect(
                /^[\x20-\x7E]+$/.test(def.displayName),
                `${name}: "${def.displayName}" contains characters the font can't render`,
            ).toBe(true);
        }
    });

    test("the rustle telegraph is never zero", () => {
        // A zero reaction delay makes the mode a coin flip. Guard it in CI.
        for (const [name, def] of Object.entries(AiDefs)) {
            expect(def.combat.reactionDelay, `${name} rustle`).toBeGreaterThanOrEqual(0.3);
        }
    });
});

describe("AI spawning", () => {
    test("the AI system is inert on non-vietnam maps", () => {
        const game = createGame(TeamMode.Solo, "main");
        expect(game.aiBarn.enabled).toBe(false);
        expect(game.aiBarn.spawn("creeper", v2.create(100, 100))).toBe(false);
    });

    test("spawning creates a disguise obstacle bound to the AI", () => {
        const game = createGame(TeamMode.Solo, "vietnam");
        const pos = game.map.getSpawnPos();

        expect(game.aiBarn.spawn("creeper", pos)).toBe(true);

        const ai = game.aiBarn.controllers[0].player;
        expect(ai.isAI).toBe(true);

        const disguise = ai.obstacleOutfit;
        expect(disguise, "AI must have a skin obstacle").toBeDefined();
        expect(disguise!.isSkin).toBe(true);
        expect(disguise!.skinPlayerId).toBe(ai.__id);
        // Which costume it wears is random, but it must be one from the pool.
        expect(
            Object.keys(MapDefs.vietnam.gameMode.ai!.disguisePool),
        ).toContain(ai.outfit);
        // A disguise the player could bump into would give the game away.
        expect(disguise!.collidable).toBe(false);
    });

    test("archetype health overrides the global player maximum", () => {
        const game = createGame(TeamMode.Solo, "vietnam");
        game.aiBarn.spawn("banyan", game.map.getSpawnPos());

        const boss = game.aiBarn.controllers[0].player;
        expect(boss.maxHealth).toBe(AiDefs.banyan.health);
        expect(boss.health).toBe(AiDefs.banyan.health);
        expect(boss.maxHealth).toBeGreaterThan(GameConfig.player.health);
    });

    test("AI are armed with a loaded gun", () => {
        const game = createGame(TeamMode.Solo, "vietnam");
        game.aiBarn.spawn("stump_runner", game.map.getSpawnPos());

        const ai = game.aiBarn.controllers[0].player;
        const primary = ai.weapons[GameConfig.WeaponSlot.Primary];
        expect(primary.type).toBeTruthy();
        expect(primary.ammo).toBeGreaterThan(0);
    });

    test("AI never despawn on the inactivity timer", () => {
        const game = createGame(TeamMode.Solo, "vietnam");
        game.aiBarn.spawn("creeper", game.map.getSpawnPos());
        expect(game.aiBarn.controllers[0].player.canDespawn()).toBe(false);
    });
});

describe("AI are invisible to the match's bookkeeping", () => {
    test("alive counts exclude AI", () => {
        const game = createGame(TeamMode.Solo, "vietnam");
        const human = game.playerBarn.addTestPlayer({});

        for (let i = 0; i < 5; i++) {
            game.aiBarn.spawn("creeper", game.map.getSpawnPos());
        }

        expect(game.playerBarn.livingPlayers.length).toBe(6);
        // The two counts players and the HUD actually see:
        expect(game.modeManager.aliveCount()).toBe(1);
        expect(game.aliveCount).toBe(1);
        expect(human.isAI).toBe(false);
    });

    test("a match ends with one human left even while AI are alive", () => {
        const game = createGame(TeamMode.Solo, "vietnam");
        const winner = game.playerBarn.addTestPlayer({});
        const loser = game.playerBarn.addTestPlayer({});

        for (let i = 0; i < 5; i++) {
            game.aiBarn.spawn("creeper", game.map.getSpawnPos());
        }

        game.started = true;
        expect(game.over).toBe(false);

        loser.kill({
            amount: 999,
            damageType: GameConfig.DamageType.Player,
            dir: v2.randomUnit(),
            source: winner,
        });

        // If AI counted as alive here the game would never end.
        expect(game.over).toBe(true);
        expect(game.modeManager.aliveCount()).toBe(1);
    });

    test("AI cannot become kill leader", () => {
        const game = createGame(TeamMode.Solo, "vietnam");
        game.aiBarn.spawn("creeper", game.map.getSpawnPos());
        const ai = game.aiBarn.controllers[0].player;
        ai.kills = 25;

        expect(game.playerBarn.getPlayerWithHighestKills()).toBeUndefined();
    });

    test("AI are excluded from the end-of-match ranking", () => {
        const game = createGame(TeamMode.Solo, "vietnam");
        game.playerBarn.addTestPlayer({});
        game.aiBarn.spawn("creeper", game.map.getSpawnPos());

        const ranked = game.modeManager.getPlayersSortedByRank();
        expect(ranked.length).toBe(1);
        expect(ranked[0].player.isAI).toBe(false);
    });

    test("AI do not keep an empty lobby alive", () => {
        const game = createGame(TeamMode.Solo, "vietnam");
        game.aiBarn.spawn("creeper", game.map.getSpawnPos());

        const connected = game.playerBarn.players.reduce(
            (n, p) => n + (p.disconnected || p.isAI ? 0 : 1),
            0,
        );
        expect(connected).toBe(0);
    });
});

describe("AI behaviour", () => {
    test("a dormant AI does not move a single unit", () => {
        const game = createGame(TeamMode.Solo, "vietnam");

        // Human parked far away so nothing can wake the AI.
        const human = game.playerBarn.addTestPlayer({ pos: v2.create(20, 20) });
        const aiPos = v2.create(game.map.width - 20, game.map.height - 20);
        expect(game.aiBarn.spawn("creeper", aiPos)).toBe(true);

        const controller = game.aiBarn.controllers[0];
        const ai = controller.player;
        const startPos: Vec2 = v2.copy(ai.pos);
        const startDir: Vec2 = v2.copy(ai.dir);

        game.step(3);

        expect(controller.state).toBe(AiState.Dormant);
        // Bit-identical, not merely close. Any drift and the disguise reads as
        // "the bush that is subtly sliding", which defeats the entire mode.
        expect(ai.pos.x).toBe(startPos.x);
        expect(ai.pos.y).toBe(startPos.y);
        expect(ai.dir.x).toBe(startDir.x);
        expect(ai.dir.y).toBe(startDir.y);
        expect(human.dead).toBe(false);
    });

    test("a nearby player wakes an ambusher", () => {
        const game = createGame(TeamMode.Solo, "vietnam");
        const pair = placeFacingPair(game, "creeper", 4);
        expect(pair, "could not find a clear spot to stage the test").toBeDefined();

        const controller = game.aiBarn.controllers[0];
        expect(controller.state).toBe(AiState.Dormant);

        game.step(0.5);
        expect(controller.state).not.toBe(AiState.Dormant);
    });

    test("an AI cannot fire during the rustle telegraph", () => {
        const game = createGame(TeamMode.Solo, "vietnam");
        const pair = placeFacingPair(game, "creeper", 4);
        expect(pair).toBeDefined();

        const ai = pair!.ai;
        const startAmmo = ai.weapons[GameConfig.WeaponSlot.Primary].ammo;

        // Wake happens on the first think tick; the telegraph then runs for
        // reactionDelay seconds. Nothing may leave the barrel inside it.
        game.step(0.3);

        expect(game.aiBarn.controllers[0].state).toBe(AiState.Rustle);
        expect(ai.weapons[GameConfig.WeaponSlot.Primary].ammo).toBe(startAmmo);
        expect(pair!.human.health).toBe(GameConfig.player.health);
    });

    test("an AI does open fire once the telegraph has elapsed", () => {
        // Sampled over several maps: whether a given clearing stays open long
        // enough for a moving AI to keep its shot depends on the layout.
        let engaged = 0;
        const trials = 5;

        for (let t = 0; t < trials; t++) {
            const game = createGame(TeamMode.Solo, "vietnam");
            const pair = placeFacingPair(game, "creeper", 4);
            if (!pair) continue;

            const ai = pair.ai;
            const startAmmo = ai.weapons[GameConfig.WeaponSlot.Primary].ammo;

            game.step(3);

            if (
                ai.weapons[GameConfig.WeaponSlot.Primary].ammo < startAmmo
                || ai.weaponManager.scheduledReload
                || pair.human.health < GameConfig.player.health
            ) {
                engaged++;
            }
        }

        expect(engaged, `only engaged in ${engaged}/${trials} setups`)
            .toBeGreaterThanOrEqual(trials - 1);
    });

    test("being shot wakes a dormant AI immediately", () => {
        const game = createGame(TeamMode.Solo, "vietnam");
        const human = game.playerBarn.addTestPlayer({ pos: v2.create(20, 20) });
        game.aiBarn.spawn("creeper", v2.create(game.map.width - 20, game.map.height - 20));

        const controller = game.aiBarn.controllers[0];
        expect(controller.state).toBe(AiState.Dormant);

        controller.player.damage({
            amount: 10,
            damageType: GameConfig.DamageType.Player,
            dir: v2.randomUnit(),
            source: human,
        });

        expect(controller.state).toBe(AiState.Rustle);
    });

    test("killing an AI drops loot worth the ammunition", () => {
        const game = createGame(TeamMode.Solo, "vietnam");
        const human = game.playerBarn.addTestPlayer({});
        game.aiBarn.spawn("creeper", game.map.getSpawnPos());

        const ai = game.aiBarn.controllers[0].player;
        const lootBefore = game.lootBarn.loots.length;

        ai.kill({
            amount: 999,
            damageType: GameConfig.DamageType.Player,
            dir: v2.randomUnit(),
            source: human,
        });

        expect(ai.dead).toBe(true);
        // Its own gun and ammo, plus the archetype's guaranteed ammo tier.
        expect(game.lootBarn.loots.length).toBeGreaterThan(lootBefore);
        // The controller must be retired so it stops being ticked.
        expect(game.aiBarn.controllers.length).toBe(0);
    });

    test("a dead AI's disguise dies with it", () => {
        const game = createGame(TeamMode.Solo, "vietnam");
        const human = game.playerBarn.addTestPlayer({});
        game.aiBarn.spawn("sniper_tree", game.map.getSpawnPos());

        const ai = game.aiBarn.controllers[0].player;
        const disguise = ai.obstacleOutfit!;
        expect(disguise.dead).toBe(false);

        ai.kill({
            amount: 999,
            damageType: GameConfig.DamageType.Player,
            dir: v2.randomUnit(),
            source: human,
        });

        expect(disguise.dead).toBe(true);
    });

    test("a full match tick with a populated jungle stays stable", () => {
        const game = createGame(TeamMode.Solo, "vietnam");
        game.playerBarn.addTestPlayer({});
        game.playerBarn.addTestPlayer({});

        game.started = true;
        game.aiBarn.seedInitialAi();
        expect(game.aiBarn.aliveCount).toBeGreaterThan(0);

        // 20 simulated seconds of directing, spawning, culling and combat.
        expect(() => game.step(20)).not.toThrow();

        // The seeded jungle is capped by area at match start; only the
        // director's reinforcements are metered against currentCap.
        const cap = game.aiBarn.director!.currentCap(2);
        expect(game.aiBarn.reinforcementCount).toBeLessThanOrEqual(cap);
    });
});

describe("the director", () => {
    test("intensity rises with damage and gates spawning", () => {
        const game = createGame(TeamMode.Solo, "vietnam");
        const human = game.playerBarn.addTestPlayer({});
        const director = game.aiBarn.director!;

        expect(director.acceptsSpawnsNear(human)).toBe(true);

        director.onPlayerDamaged(human, 100);
        expect(director.intensityOf(human)).toBeGreaterThan(85);
        // At peak the jungle stops sending more, exactly like L4D.
        expect(director.acceptsSpawnsNear(human)).toBe(false);
    });

    test("intensity decays back to calm out of contact", () => {
        const game = createGame(TeamMode.Solo, "vietnam");
        const human = game.playerBarn.addTestPlayer({});
        const director = game.aiBarn.director!;

        director.onPlayerDamaged(human, 60);
        const peak = director.intensityOf(human);

        game.step(3);
        expect(director.intensityOf(human)).toBeLessThan(peak);
    });

    test("the population cap scales with living humans", () => {
        const game = createGame(TeamMode.Solo, "vietnam");
        const director = game.aiBarn.director!;
        expect(director.currentCap(1)).toBeLessThan(director.currentCap(10));
        expect(director.currentCap(80)).toBeLessThanOrEqual(Config.vietnam.maxAlive);
    });

    test("spawn density escalates as the gas closes", () => {
        const game = createGame(TeamMode.Solo, "vietnam");
        const director = game.aiBarn.director!;

        game.gas.circleIdx = 0;
        const early = director.escalationMult();
        game.gas.circleIdx = 6;
        const late = director.escalationMult();

        expect(late).toBeGreaterThan(early);
    });
});

describe("map density", () => {
    /** Blocking foliage per 1000 square units — the number that decides whether
     * a map feels like a forest or like a wall. */
    function foliageDensity(teamMode: TeamMode, duelMode: boolean, mapName = "vietnam") {
        // Averaged over a few generations: map layout is random, and a single
        // sample makes these thresholds flaky rather than meaningful.
        const samples = 3;
        let total = 0;

        for (let i = 0; i < samples; i++) {
            const game = createGame(teamMode, mapName as never, duelMode);
            let blocking = 0;
            for (const o of game.map.obstacles) {
                if (o.isSkin) continue;
                if (!/^(tree_|bush_)/.test(o.type)) continue;
                if (o.collidable) blocking++;
            }
            total += (blocking / (game.map.width * game.map.height)) * 1000;
        }

        return total / samples;
    }

    test("every AI disguise has real obstacles to hide among", () => {
        const game = createGame(TeamMode.Solo, "vietnam");

        const counts = new Map<string, number>();
        for (const o of game.map.obstacles) {
            if (o.isSkin) continue;
            counts.set(o.type, (counts.get(o.type) ?? 0) + 1);
        }

        for (const name of Object.keys(MapDefs.vietnam.gameMode.ai!.disguisePool)) {
            const outfit = GameObjectDefs.typeToDef(name, "outfit");
            const disguise = outfit.obstacleType!;
            // Disguise variants are the "b" suffixed twins of real map obstacles
            // (bush_01b -> bush_01). A disguise with no real counterparts on the
            // map is a flashing "shoot me" sign.
            const real = disguise.endsWith("b") && !counts.has(disguise)
                ? disguise.slice(0, -1)
                : disguise;
            expect(
                counts.get(real) ?? 0,
                `${name} disguises as ${disguise}, but the map has too few real ${real}`,
            ).toBeGreaterThan(30);
        }
    });

    test("foliage density is the same in duels as in full matches", () => {
        // fixedSpawns counts are absolute while duels shrink the map, so without
        // area scaling a duel map is ~1/scale^2 times as cluttered.
        const solo = foliageDensity(TeamMode.Solo, false);
        const duel = foliageDensity(TeamMode.Solo, true);

        expect(duel).toBeLessThan(solo * 1.35);
        expect(duel).toBeGreaterThan(solo * 0.5);
    });

    test("the duel scaling fix applies to every map, not just vietnam", () => {
        const solo = foliageDensity(TeamMode.Solo, false, "woods");
        const duel = foliageDensity(TeamMode.Solo, true, "woods");
        expect(duel).toBeLessThan(solo * 1.35);
    });

    test("solo and squad play at a comparable density", () => {
        const solo = foliageDensity(TeamMode.Solo, false);
        const squad = foliageDensity(TeamMode.Squad, false);
        expect(Math.abs(solo - squad)).toBeLessThan(1);
    });
});

describe("AI movement is smooth", () => {
    /** Run the game at a real 100 Hz rather than game.step's 10 Hz, so the
     * per-tick behaviour between think ticks is actually exercised. */
    function runFine(game: Game, seconds: number, onTick: () => void) {
        for (let i = 0; i < seconds * 100; i++) {
            game.update(0.01);
            onTick();
        }
    }

    test("an engaging AI turns at a bounded rate instead of snapping", () => {
        const game = createGame(TeamMode.Solo, "vietnam");
        const pair = placeFacingPair(game, "creeper", 6);
        expect(pair).toBeDefined();

        const ai = pair!.ai;
        let prev = v2.copy(ai.dir);
        let maxTurn = 0;

        runFine(game, 2, () => {
            const dot = Math.max(-1, Math.min(1, v2.dot(v2.normalizeSafe(prev), v2.normalizeSafe(ai.dir))));
            maxTurn = Math.max(maxTurn, Math.acos(dot));
            prev = v2.copy(ai.dir);
        });

        // TURN_RATE is 7 rad/s, so a 10 ms tick can turn at most 0.07 rad.
        // Before the fix the aim error was resampled every tick and this
        // spiked to the full width of the error cone, which is what made a
        // disguised enemy look like it was vibrating.
        expect(maxTurn).toBeLessThanOrEqual(0.08);
    });

    test("an engaging AI does not flip its movement direction every tick", () => {
        const game = createGame(TeamMode.Solo, "vietnam");
        const pair = placeFacingPair(game, "stump_runner", 10);
        expect(pair).toBeDefined();

        const ai = pair!.ai;
        let prev = "";
        let flips = 0;

        runFine(game, 2, () => {
            const key = `${+ai.moveLeft}${+ai.moveRight}${+ai.moveUp}${+ai.moveDown}`;
            if (prev && key !== prev) flips++;
            prev = key;
        });

        // Movement is planned on the 10 Hz think tick and held in between, so
        // over 2 seconds there are at most ~20 opportunities to change.
        expect(flips).toBeLessThanOrEqual(20);
    });
});

describe("the disguise holds up", () => {
    test("a dormant AI has its gun stowed", () => {
        const game = createGame(TeamMode.Solo, "vietnam");
        game.aiBarn.spawn("sniper_tree", game.map.getSpawnPos());
        const ai = game.aiBarn.controllers[0].player;

        // The skin obstacle is drawn over the player's body, but a rifle is
        // longer than a bush is wide, so a drawn gun pokes out of the foliage
        // and gives the disguise away from across the map.
        // What matters is that no gun is drawn, not which sidearm it drew.
        expect(ai.curWeapIdx).toBe(GameConfig.WeaponSlot.Melee);
        expect(
            GameObjectDefs.typeToDef(ai.activeWeapon).type,
            "a dormant AI must not be holding a gun",
        ).toBe("melee");
    });

    test("the gun comes out as part of the wake telegraph", () => {
        const game = createGame(TeamMode.Solo, "vietnam");
        const human = game.playerBarn.addTestPlayer({ pos: v2.create(20, 20) });
        game.aiBarn.spawn(
            "creeper",
            v2.create(game.map.width - 20, game.map.height - 20),
        );

        const controller = game.aiBarn.controllers[0];
        expect(controller.player.curWeapIdx).toBe(GameConfig.WeaponSlot.Melee);

        controller.onDamaged(human);
        game.update(0.01);

        expect(controller.state).toBe(AiState.Rustle);
        expect(controller.player.curWeapIdx).toBe(GameConfig.WeaponSlot.Primary);
    });

    test("an AI that loses its target puts the gun away again", () => {
        {
            const game = createGame(TeamMode.Solo, "vietnam");
            const human = game.playerBarn.addTestPlayer({ pos: v2.create(20, 20) });
            game.aiBarn.spawn(
                "creeper",
                v2.create(game.map.width - 20, game.map.height - 20),
            );

            const controller = game.aiBarn.controllers[0];
            controller.onDamaged(human);
            game.step(1);
            expect(controller.player.curWeapIdx).toBe(GameConfig.WeaponSlot.Primary);

            // It searches the area before giving up, and how long that takes
            // varies with the terrain it wanders into — so poll for the outcome
            // rather than pinning a specific number of seconds.
            let rehid = false;
            for (let i = 0; i < 60 && !rehid; i++) {
                game.step(1);
                rehid = controller.state === AiState.Dormant;
            }

            expect(rehid, "AI never went back to hiding").toBe(true);
            expect(
                controller.player.curWeapIdx,
                "a re-hidden AI must have the gun stowed",
            ).toBe(GameConfig.WeaponSlot.Melee);
        }
    });
});

describe("point blank", () => {
    /** Stand a player exactly on top of an AI and see who wins. */
    function hug(archetype: AiArchetype) {
        const game = createGame(TeamMode.Solo, "vietnam");
        const pos = game.map.getSpawnPos();
        const human = game.playerBarn.addTestPlayer({ pos });
        expect(game.aiBarn.spawn(archetype, v2.copy(pos))).toBe(true);

        for (let i = 0; i < 1000; i++) game.update(0.01);
        return human;
    }

    test.for(["sniper_tree", "creeper", "stump_runner", "banyan"] as const)(
        "%s can fight back when hugged",
        (archetype) => {
            // Bullets spawn at the end of the barrel, so a player standing on an
            // AI is behind every shot it fires. Rooted archetypes were an
            // outright safe spot: zero damage over ten seconds.
            const human = hug(archetype);
            expect(human.health).toBeLessThan(GameConfig.player.health);
        },
    );

    test("a rooted entity can shuffle out of a hug but not reposition", () => {
        // No current archetype ships with speedMult 0 — the sniper is the one
        // that used to, and it picked up real mobility instead of staying a
        // turret. The mechanic behind that guarantee (a hugged AI gets just
        // enough speed to break contact and no more) is still real code and
        // still worth holding to a body, so it's exercised directly against
        // the archetype table rather than left untested because nothing
        // currently ships with it.
        const original = AiDefs.sniper_tree.speedMult;
        AiDefs.sniper_tree.speedMult = 0;

        try {
            const game = createGame(TeamMode.Solo, "vietnam");
            const pos = game.map.getSpawnPos();
            game.playerBarn.addTestPlayer({ pos });
            game.aiBarn.spawn("sniper_tree", v2.copy(pos));
            const ai = game.aiBarn.controllers[0].player;
            const start = v2.copy(ai.pos);

            for (let i = 0; i < 600; i++) game.update(0.01);

            const moved = v2.distance(start, ai.pos);
            expect(moved, "must be able to break the hug").toBeGreaterThan(0.5);
            expect(moved, "must not become genuinely mobile").toBeLessThan(30);
        } finally {
            AiDefs.sniper_tree.speedMult = original;
        }
    });
});

describe("the seeded jungle", () => {
    test("AI are placed across the map when the match starts", () => {
        const game = createGame(TeamMode.Solo, "vietnam");
        game.playerBarn.addTestPlayer({});
        game.playerBarn.addTestPlayer({});

        expect(game.aiBarn.aliveCount).toBe(0);
        game.started = true;
        game.aiBarn.seedInitialAi();

        const seeded = game.aiBarn.controllers.filter((c) => c.persistent);
        expect(seeded.length).toBeGreaterThan(40);
        // Spread over the map, not clustered near the players.
        const xs = seeded.map((c) => c.player.pos.x);
        expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(game.map.width * 0.5);
    });

    test("seeding is scaled by land area, not a flat count", () => {
        const density = (teamMode: TeamMode, duelMode: boolean) => {
            const game = createGame(teamMode, "vietnam", duelMode);
            game.playerBarn.addTestPlayer({});
            game.started = true;
            game.aiBarn.seedInitialAi();
            const seeded = game.aiBarn.controllers.filter((c) => c.persistent).length;
            return (seeded / game.map.shoreArea) * 250000;
        };

        const solo = density(TeamMode.Solo, false);
        const duel = density(TeamMode.Solo, true);
        // A duel map is a quarter of the area; it should get a quarter of the
        // jungle, not the same population crammed in.
        expect(Math.abs(solo - duel)).toBeLessThan(6);
    });

    test("the seeded population is never culled for being far away", () => {
        const game = createGame(TeamMode.Solo, "vietnam");
        game.playerBarn.addTestPlayer({ pos: v2.create(30, 30) });
        game.started = true;
        game.aiBarn.seedInitialAi();

        const seeded = game.aiBarn.controllers
            .filter((c) => c.persistent)
            .map((c) => c.player);
        expect(seeded.length).toBeGreaterThan(20);

        game.step(30);

        // The ambush waiting in the far corner has to still be there when
        // someone finally walks into it. Dying is fine; being quietly deleted
        // for being far from a player is not.
        for (const ai of seeded) {
            const present = game.playerBarn.players.includes(ai);
            expect(
                present || ai.dead,
                "a living seeded AI was culled for being far away",
            ).toBe(true);
        }
    });

    test("director reinforcements are capped separately from the seeded population", () => {
        const game = createGame(TeamMode.Solo, "vietnam");
        game.playerBarn.addTestPlayer({});
        game.playerBarn.addTestPlayer({});
        game.started = true;
        game.aiBarn.seedInitialAi();

        game.step(45);

        const cap = game.aiBarn.director!.currentCap(2);
        expect(game.aiBarn.reinforcementCount).toBeLessThanOrEqual(cap);
        expect(game.aiBarn.aliveCount).toBeGreaterThan(cap);
    });

    test("group ids are recycled so long matches don't exhaust the pool", () => {
        const game = createGame(TeamMode.Solo, "vietnam");
        game.playerBarn.addTestPlayer({});

        // The allocator is 255 wide and is never replenished by the engine.
        // AI spawn and die continuously, so without recycling a long match
        // dies with "Ran out of ID's".
        let spawned = 0;
        expect(() => {
            for (let cycle = 0; cycle < 30; cycle++) {
                const made: Player[] = [];
                for (let i = 0; i < 20; i++) {
                    const p = v2.create(
                        Math.random() * game.map.width,
                        Math.random() * game.map.height,
                    );
                    if (!game.map.canPlayerSpawn(p)) continue;
                    if (game.aiBarn.spawn("creeper", p)) {
                        spawned++;
                        made.push(game.aiBarn.controllers.at(-1)!.player);
                    }
                }
                for (const ai of made) game.aiBarn.despawn(ai);
                game.aiBarn.controllers.length = 0;
            }
        }).not.toThrow();

        expect(spawned).toBeGreaterThan(255);
    });
});

describe("team modes", () => {
    // AI are deliberately group-less. Anything that assumes every player has a
    // group crashes on them, and only in duo/squad — which is exactly how the
    // first version shipped a crash that solo tests never saw.
    test.for([TeamMode.Duo, TeamMode.Squad])("AI survive a match in team mode %i", (mode) => {
        const game = createGame(mode as TeamMode, "vietnam");
        const group = game.playerBarn.addGroup(false);
        const a = game.playerBarn.addTestPlayer({ group });
        game.playerBarn.addTestPlayer({ group });

        game.started = true;
        expect(() => game.aiBarn.seedInitialAi()).not.toThrow();
        expect(game.aiBarn.aliveCount).toBeGreaterThan(0);

        const ai = game.aiBarn.controllers[0].player;
        expect(ai.group).toBeUndefined();

        // Damaging an AI writes health, which used to dereference its group.
        expect(() =>
            ai.damage({
                amount: 10,
                damageType: GameConfig.DamageType.Player,
                dir: v2.randomUnit(),
                source: a,
            })
        ).not.toThrow();

        expect(() => game.step(10)).not.toThrow();
    });

    test.for([TeamMode.Duo, TeamMode.Squad])(
        "an AI dying in team mode %i doesn't crash the tick",
        (mode) => {
            // handlePlayerDeath dereferences player.group in team modes to work
            // out downs and revives. AI have no group, so before this every AI
            // death in a duo or squad match threw and took the tick with it.
            const game = createGame(mode as TeamMode, "vietnam");
            const group = game.playerBarn.addGroup(false);
            const human = game.playerBarn.addTestPlayer({ group });
            game.playerBarn.addTestPlayer({ group });
            game.started = true;

            expect(game.aiBarn.spawn("creeper", game.map.getSpawnPos())).toBe(true);
            const ai = game.aiBarn.controllers[0].player;

            expect(() =>
                ai.damage({
                    amount: 999,
                    damageType: GameConfig.DamageType.Player,
                    dir: v2.randomUnit(),
                    source: human,
                })
            ).not.toThrow();

            // Dead outright, never downed — there is nobody to revive a tree.
            expect(ai.dead).toBe(true);
            expect(ai.downed).toBe(false);
            expect(() => game.step(2)).not.toThrow();
        },
    );

    test("AI don't count as alive groups in team modes", () => {
        const game = createGame(TeamMode.Squad, "vietnam");
        const group = game.playerBarn.addGroup(false);
        game.playerBarn.addTestPlayer({ group });
        game.started = true;
        game.aiBarn.seedInitialAi();

        // One real group, however many trees are walking around.
        expect(game.modeManager.aliveCount()).toBe(1);
        expect(game.aliveCount).toBe(1);
    });
});

describe("pursuit", () => {
    test("a hunter reaches a player who stops running", () => {
        // The clearest symptom of the original bug: an AI walked to the last
        // place it saw you and stopped dead, so it never arrived even when you
        // were standing still nearby.
        //
        // Judged against the archetype's own preferred range, not an arbitrary
        // distance — a Stump Runner that closes to 14m and starts shooting has
        // done its job, and an earlier version of this test failed it for that.
        const reach = AiDefs.stump_runner.combat.preferredRange + 4;
        let reached = 0;
        const trials = 8;

        for (let t = 0; t < trials; t++) {
            const game = createGame(TeamMode.Solo, "vietnam");
            const start = game.map.getSpawnPos();
            const human = game.playerBarn.addTestPlayer({ pos: start });
            game.aiBarn.spawn("stump_runner", v2.add(start, v2.create(10, 0)));
            const ai = game.aiBarn.controllers[0].player;

            // Run for three seconds, then go to ground.
            human.moveRight = true;
            for (let i = 0; i < 300 && !human.dead; i++) game.update(0.01);
            human.moveRight = false;

            let closest = Infinity;
            for (let i = 0; i < 1200 && !human.dead; i++) {
                game.update(0.01);
                closest = Math.min(closest, v2.distance(human.pos, ai.pos));
            }

            if (human.dead || closest < reach) reached++;
        }

        expect(reached, `only reached the player in ${reached}/${trials} attempts`)
            .toBe(trials);
    }, SIM_TIMEOUT);

    test("a hunter does not fall far behind a sprinting player", () => {
        // Secondary guard, judged loosely: steering has no pathfinding, and a
        // player sprinting in a dead straight line should be able to open some
        // ground. Falling 30m+ behind means it stopped chasing.
        const deltas: number[] = [];

        for (let t = 0; t < 9; t++) {
            const game = createGame(TeamMode.Solo, "vietnam");
            const start = game.map.getSpawnPos();
            const human = game.playerBarn.addTestPlayer({ pos: start });
            game.aiBarn.spawn("stump_runner", v2.add(start, v2.create(8, 0)));
            const ai = game.aiBarn.controllers[0].player;

            human.moveRight = true;
            const before = v2.distance(human.pos, ai.pos);
            for (let i = 0; i < 900; i++) {
                game.update(0.01);
                if (human.dead) break;
            }
            if (human.dead) continue;
            deltas.push(v2.distance(human.pos, ai.pos) - before);
        }

        deltas.sort((a, b) => a - b);
        const median = deltas[Math.floor(deltas.length / 2)];
        expect(median, `median chase delta was ${median.toFixed(1)}m`).toBeLessThan(18);
    }, SIM_TIMEOUT);

    test("an awake AI never sits there with no movement input", () => {
        const game = createGame(TeamMode.Solo, "vietnam");
        const start = game.map.getSpawnPos();
        const human = game.playerBarn.addTestPlayer({ pos: start });
        game.aiBarn.spawn("stump_runner", v2.add(start, v2.create(8, 0)));
        const controller = game.aiBarn.controllers[0];
        const ai = controller.player;

        human.moveRight = true;
        let awake = 0;
        let idle = 0;

        for (let i = 0; i < 900; i++) {
            game.update(0.01);
            if (controller.state === AiState.Stalk || controller.state === AiState.Engage) {
                awake++;
                if (!ai.moveLeft && !ai.moveRight && !ai.moveUp && !ai.moveDown) idle++;
            }
        }

        expect(awake).toBeGreaterThan(100);
        // A little idling is legitimate (point-blank backing off, arriving on a
        // search goal). Standing still for most of a chase is the bug.
        expect(idle / awake).toBeLessThan(0.4);
    }, SIM_TIMEOUT);

    test("a kiter repositions but does not turn into a chaser", () => {
        // Sniper Tree used to be speedMult 0 — a fixed turret that could never
        // wander at all. It's mobile now, on purpose, so it can back off a
        // flanker or relocate for a lane instead of being a guaranteed free
        // kill for anyone who finds an angle on it. What it still must not do
        // is become a second Stump Runner: `pursueRange: 20` means it gives up
        // tracking a target's live position well before a hunter would, and
        // this is the bound that would catch it quietly turning into a chaser.
        //
        // Measured for calibration: a real hunter (Stump Runner) in this exact
        // scenario displaces a median of 75m over the same 9 seconds; the
        // sniper's own median is 23m with a max of 42m. 55 sits with margin on
        // both sides of that gap.
        const game = createGame(TeamMode.Solo, "vietnam");
        const start = game.map.getSpawnPos();
        const human = game.playerBarn.addTestPlayer({ pos: start });
        game.aiBarn.spawn("sniper_tree", v2.add(start, v2.create(12, 0)));
        const controller = game.aiBarn.controllers[0];
        const ai = controller.player;
        const home = v2.copy(ai.pos);

        // Forced awake rather than relying on organic wake-up: dense jungle
        // occasionally blocks line of sight at a random 12-unit offset, which
        // is a fact about map generation, not about the behaviour this test
        // is checking.
        controller.onDamaged(human);
        human.moveRight = true;
        for (let i = 0; i < 900; i++) game.update(0.01);

        const moved = v2.distance(home, ai.pos);
        // Genuinely mobile — not the old speedMult-0 turret, which measures at
        // essentially zero displacement in this exact scenario.
        expect(moved, "should have repositioned, not sat at spawn").toBeGreaterThan(3);
        expect(moved, "should not have turned into a full chaser").toBeLessThan(55);
    });
});

/** Find a closed, usable door somewhere on the map. */
function findClosedDoor(game: Game) {
    return game.map.obstacles.find(
        (o) =>
            o.isDoor && !!o.door && !o.dead && !o.door.open && o.door.canUse
            && !o.door.locked && o.layer === 0,
    );
}

describe("interacting with the world", () => {
    test("AI open doors in their way", () => {
        // Sampled across maps: whether a given doorway is approachable from the
        // side we drop the AI on depends on the building it belongs to.
        let opened = 0;
        const trials = 4;

        for (let t = 0; t < trials; t++) {
            const game = createGame(TeamMode.Solo, "vietnam");
            const door = findClosedDoor(game);
            if (!door) continue;

            const human = game.playerBarn.addTestPlayer({
                pos: v2.add(door.pos, v2.create(0, 6)),
            });
            if (!game.aiBarn.spawn("stump_runner", v2.add(door.pos, v2.create(0, -2)))) {
                continue;
            }
            game.aiBarn.controllers[0].onDamaged(human);

            // Generous budget: the fixed (0, -2) spawn offset isn't aligned
            // with every door's actual swing orientation, so on some maps the
            // AI has to walk around to the real opening rather than being
            // handed it. Three seconds was tight enough to fail that ~10% of
            // the time for reasons that had nothing to do with door-opening —
            // it hadn't finished arriving yet.
            for (let i = 0; i < 800 && !door.door!.open; i++) game.update(0.01);
            if (door.door!.open) opened++;
        }

        expect(opened, `only opened a door in ${opened}/${trials} setups`)
            .toBeGreaterThanOrEqual(2);
    }, SIM_TIMEOUT);

    test("does not open a door it can't actually reach", () => {
        // The broad-phase grid query behind door detection buckets the world
        // into 16-unit cells and returns anything whose cell overlaps the
        // search circle — it is not a real distance check. A door sitting
        // anywhere in the same or an adjoining cell used to come back as a
        // "hit" and get opened outright, so an AI 14 metres from a door across
        // the room could pop it as if it were standing next to it. The real
        // check is the same circle-vs-collider test a human's own interact key
        // uses, same as `getInteractableObstacles`.
        const game = createGame(TeamMode.Solo, "vietnam");

        let base: Vec2 | undefined;
        for (let x = 100; x < game.map.width - 100 && !base; x += 20) {
            for (let y = 100; y < game.map.height - 100 && !base; y += 20) {
                const p = v2.create(x, y);
                if (
                    game.map.canPlayerSpawn(p)
                    && game.map.canPlayerSpawn(v2.add(p, v2.create(15, 1)))
                ) {
                    base = p;
                }
            }
        }
        expect(base, "no clear spot to build the scenario").toBeDefined();

        // Snap to a cell boundary so the AI and the far door land in the same
        // 16-unit broad-phase cell.
        const cell = 16;
        const cellOrigin = v2.create(
            Math.floor(base!.x / cell) * cell + 1,
            Math.floor(base!.y / cell) * cell + 1,
        );

        const door = game.map.genObstacle(
            "house_door_02",
            v2.add(cellOrigin, v2.create(14, 1)),
            0,
            0,
            1,
        );
        expect(game.aiBarn.spawn("creeper", v2.copy(cellOrigin))).toBe(true);
        const controller = game.aiBarn.controllers[0] as unknown as {
            _doorCooldown: number;
            _handleDoors(): void;
        };

        expect(v2.distance(cellOrigin, door.pos)).toBeGreaterThan(10);
        door.door!.open = false;
        controller._doorCooldown = 0;
        controller._handleDoors();

        expect(door.door!.open, "opened a door 14m away").toBe(false);
    });

    test("a destructible obstacle does not stop an AI", () => {
        // Deliberately not asserting *how*. With proactive pathfinding the AI
        // usually walks around a crate — which is what a player does — and only
        // shoots through when there's no way past. Either outcome satisfies the
        // requirement; pinning one of them made this test fail the moment the
        // better behaviour was added.
        let handled = 0;
        let tried = 0;

        for (let t = 0; t < 5 && tried < 3; t++) {
            const game = createGame(TeamMode.Solo, "vietnam");
            const crate = game.map.obstacles.find(
                (o) => o.type === "crate_01" && !o.dead && o.destructible && o.layer === 0,
            );
            if (!crate) continue;

            const dir = v2.create(1, 0);
            const human = game.playerBarn.addTestPlayer({
                pos: v2.add(crate.pos, v2.mul(dir, 5)),
            });
            if (!game.aiBarn.spawn("stump_runner", v2.add(crate.pos, v2.mul(dir, -4)))) {
                continue;
            }
            tried++;

            const controller = game.aiBarn.controllers[0];
            controller.onDamaged(human);

            const startHealth = crate.health;
            let closest = Infinity;
            for (let i = 0; i < 1500; i++) {
                game.update(0.01);
                closest = Math.min(closest, v2.distance(controller.player.pos, human.pos));
            }

            const brokeThrough = crate.dead || crate.health < startHealth;
            const wentAround = closest < 6;
            if (brokeThrough || wentAround) handled++;
        }

        expect(tried, "no crate to test with").toBeGreaterThan(0);
        expect(handled, `blocked by a crate in ${tried - handled}/${tried} setups`)
            .toBe(tried);
    }, SIM_TIMEOUT);

});

describe("every tree is a different tree", () => {
    test("disguises are drawn at random from the pool", () => {
        const game = createGame(TeamMode.Solo, "vietnam");
        const seen = new Set<string>();

        for (let i = 0; i < 60; i++) {
            game.aiBarn.spawn("creeper", game.map.getSpawnPos());
        }
        for (const c of game.aiBarn.controllers) seen.add(c.outfit);

        // Behaviour and appearance are decoupled: the same role turns up wearing
        // many different shapes, so a silhouette tells you nothing.
        expect(seen.size).toBeGreaterThan(2);
        for (const outfit of seen) {
            expect(
                Object.keys(MapDefs.vietnam.gameMode.ai!.disguisePool),
            ).toContain(outfit);
        }
    });

    test("the same disguise turns up on different roles", () => {
        const game = createGame(TeamMode.Solo, "vietnam");
        const byArchetype = new Map<string, Set<string>>();

        for (const archetype of ["creeper", "sniper_tree", "stump_runner"] as const) {
            const set = new Set<string>();
            for (let i = 0; i < 40; i++) {
                const before = game.aiBarn.controllers.length;
                game.aiBarn.spawn(archetype, game.map.getSpawnPos());
                if (game.aiBarn.controllers.length > before) {
                    set.add(game.aiBarn.controllers.at(-1)!.outfit);
                }
            }
            byArchetype.set(archetype, set);
        }

        // A bush can be the sniper and a tree can be the one that charges you.
        const bushWearers = [...byArchetype.entries()]
            .filter(([, set]) => set.has("outfitBush"))
            .length;
        expect(bushWearers).toBeGreaterThan(1);
    });

    test("AI carry fists and nothing else", () => {
        const game = createGame(TeamMode.Solo, "vietnam");

        for (let i = 0; i < 40; i++) {
            game.aiBarn.spawn("creeper", game.map.getSpawnPos());
        }

        for (const c of game.aiBarn.controllers) {
            const melee = c.player.weapons[GameConfig.WeaponSlot.Melee].type;
            expect(melee, "a visible blade would give the disguise away").toBe("fists");
            expect(
                (MeleeDefs[melee] as { worldImg?: unknown }).worldImg,
            ).toBeUndefined();
        }
    });

    test("fists are what swing at point blank", () => {
        let swung = 0;
        const trials = 4;

        for (let t = 0; t < trials; t++) {
            const game = createGame(TeamMode.Solo, "vietnam");
            const pos = game.map.getSpawnPos();
            const human = game.playerBarn.addTestPlayer({ pos });
            if (!game.aiBarn.spawn("stump_runner", v2.copy(pos))) continue;
            const ai = game.aiBarn.controllers[0].player;

            let sawMelee = false;
            for (let i = 0; i < 400; i++) {
                game.update(0.01);
                if (ai.curWeapIdx === GameConfig.WeaponSlot.Melee) sawMelee = true;
            }

            // It swings while hugged, then backs off and returns to the gun —
            // so check that melee happened, not what it ends up holding.
            if (sawMelee && human.health < GameConfig.player.health) swung++;
        }

        expect(swung, `only swung in ${swung}/${trials} setups`)
            .toBeGreaterThanOrEqual(trials - 1);
    });
});

describe("acting like a player would", () => {
    test("only living cover can get up and walk", () => {
        // A rock that stands up and chases you reads as a bug, not an ambush.
        for (const name of Object.keys(MapDefs.vietnam.gameMode.ai!.disguisePool)) {
            const outfit = GameObjectDefs.typeToDef(name, "outfit");
            expect(
                /^(tree_|bush_)/.test(outfit.obstacleType!),
                `${name} disguises as ${outfit.obstacleType}, which isn't foliage`,
            ).toBe(true);
        }
    });

    test("still fights while running for the circle", () => {
        // Fleeing the gas used to mute the trigger outright: `player.shootHold
        // = false` on every tick of the escape, no matter what. A tree that
        // stops fighting the instant the gas starts, even with somebody
        // standing right next to it, reads as broken rather than as "busy
        // running" — legs and aim are independent inputs in this game, so
        // there was never a reason to drop one for the other.
        const game = createGame(TeamMode.Solo, "vietnam");
        game.playerBarn.addTestPlayer({});
        game.started = true;
        game.gas.mode = GameConfig.GasMode.Waiting;
        game.gas.currentPos = v2.copy(game.map.center);
        game.gas.currentRad = 40;

        const outside = v2.add(game.map.center, v2.create(80, 0));
        const human = game.playerBarn.addTestPlayer({ pos: outside });
        expect(game.aiBarn.spawn("stump_runner", v2.add(outside, v2.create(2, 0))))
            .toBe(true);
        const controller = game.aiBarn.controllers[0];
        const ai = controller.player;
        controller.onDamaged(human);

        let firedWhileFleeing = 0;
        const startHealth = human.health;

        for (let i = 0; i < 500; i++) {
            // The gas goal sits well inside the circle, so a tree that's just
            // passing the human on its way there only shares a doorway with
            // them for an instant — not what "even i'm close" is reporting.
            // Keep the human glued to the fleeing tree's flank instead, the
            // way someone actually chasing it down would, so the whole run
            // is spent at melee-to-gun range rather than mostly at range 50+.
            v2.set(human.pos, v2.add(ai.pos, v2.create(2, 0)));
            game.update(0.01);
            if (controller.isFleeingGas && ai.shootHold) firedWhileFleeing++;
        }

        expect(firedWhileFleeing, "never fired a shot while fleeing").toBeGreaterThan(0);
        // And it has to be real damage, not some safety net that stops a
        // player from actually dying to a tree that's supposedly still fighting.
        expect(human.health, "took no damage despite firing").toBeLessThan(startHealth);
    });

    test("AI run for the circle instead of dissolving in the gas", () => {
        const game = createGame(TeamMode.Solo, "vietnam");
        game.playerBarn.addTestPlayer({});
        game.playerBarn.addTestPlayer({});
        game.started = true;
        // Pin the circle somewhere small and central so "outside" is unambiguous.
        game.gas.mode = GameConfig.GasMode.Waiting;
        game.gas.currentPos = v2.copy(game.map.center);
        game.gas.currentRad = 60;

        const outside = v2.add(game.map.center, v2.create(110, 0));
        expect(game.aiBarn.spawn("stump_runner", outside)).toBe(true);

        const ai = game.aiBarn.controllers[0].player;
        const before = v2.distance(ai.pos, game.gas.currentPos);
        for (let i = 0; i < 500; i++) game.update(0.01);
        const after = v2.distance(ai.pos, game.gas.currentPos);

        expect(after, "AI should have moved toward the safe zone").toBeLessThan(before);
    }, SIM_TIMEOUT);

    test("even a rooted archetype uproots rather than dissolving in the gas", () => {
        // Earlier this asserted the opposite — that a static archetype stood its
        // ground and died. Standing still while dissolving isn't something
        // anything alive does, so they now run and re-root once safe.
        //
        // No current archetype ships with speedMult 0 — Sniper Tree, the one
        // that used to, picked up real mobility instead of staying a turret —
        // so this is forced against the archetype table to keep exercising the
        // rooted-uproots-for-gas code path rather than letting it go untested
        // just because nothing currently ships rooted.
        const originalSpeed = AiDefs.sniper_tree.speedMult;
        AiDefs.sniper_tree.speedMult = 0;

        try {
            // Two attempts, same ~2% stranding rate as the archetype sweep.
            let made = 0;
            let attempts = 0;

            for (let t = 0; t < 2; t++) {
                const game = createGame(TeamMode.Solo, "vietnam");
                game.playerBarn.addTestPlayer({ pos: game.map.center });
                game.started = true;
                game.gas.mode = GameConfig.GasMode.Moving;
                game.gas.currentPos = v2.copy(game.map.center);
                game.gas.currentRad = 70;

                let outside: Vec2 | undefined;
                for (let a = 0; a < 16; a++) {
                    const ang = ((a + t * 5) / 16) * Math.PI * 2;
                    const p = v2.add(
                        game.map.center,
                        v2.create(Math.cos(ang) * 120, Math.sin(ang) * 120),
                    );
                    if (game.map.canPlayerSpawn(p)) { outside = p; break; }
                }
                if (!outside) continue;
                if (!game.aiBarn.spawn("sniper_tree", outside)) continue;

                attempts++;
                const ai = game.aiBarn.controllers[0].player;
                const startDist = v2.distance(ai.pos, game.gas.currentPos);

                let endDist = startDist;
                for (let i = 0; i < 2000 && !ai.dead; i++) {
                    game.update(0.01);
                    endDist = v2.distance(ai.pos, game.gas.currentPos);
                    if (endDist < startDist - 25) break;
                }
                // The point is that it moved toward safety at all — a rooted
                // archetype used to sit there and dissolve.
                if (!ai.dead && endDist < startDist - 20) made++;
            }

            expect(attempts, "no valid setup outside the circle").toBeGreaterThan(0);
            expect(made, `rooted AI moved to safety only ${made}/${attempts} times`)
                .toBeGreaterThan(0);
        } finally {
            AiDefs.sniper_tree.speedMult = originalSpeed;
        }
    }, SIM_TIMEOUT);

    test("every archetype can find its way out of the gas", () => {
        // ~2% of runs still strand an AI somewhere steering and A* between them
        // can't resolve, so each archetype gets three attempts and must make it
        // in at least two. A real regression fails all three.
        for (const archetype of ["stump_runner", "creeper", "sniper_tree"] as const) {
            let made = 0;
            let attempts = 0;

            for (let t = 0; t < 3 && made < 2; t++) {
                const game = createGame(TeamMode.Solo, "vietnam");
                game.playerBarn.addTestPlayer({ pos: game.map.center });
                game.started = true;
                game.gas.mode = GameConfig.GasMode.Moving;
                game.gas.currentPos = v2.copy(game.map.center);
                game.gas.currentRad = 70;
                game.gas.doDamage = true;
                game.gas.damage = 2;

                let outside: Vec2 | undefined;
                for (let a = 0; a < 16; a++) {
                    const ang = ((a + t) / 16) * Math.PI * 2;
                    const p = v2.add(
                        game.map.center,
                        v2.create(Math.cos(ang) * 120, Math.sin(ang) * 120),
                    );
                    if (game.map.canPlayerSpawn(p)) { outside = p; break; }
                }
                if (!outside) continue;
                if (!game.aiBarn.spawn(archetype, outside)) continue;

                attempts++;
                const ai = game.aiBarn.controllers[0].player;

                // Break as soon as it's inside: simulating the full 40s for
                // every archetype pushed this past vitest's default timeout,
                // which reads as a failure but isn't one.
                let safe = false;
                for (let i = 0; i < 2000 && !ai.dead && !safe; i++) {
                    game.update(0.01);
                    safe = v2.distance(ai.pos, game.gas.currentPos) < game.gas.currentRad;
                }
                if (safe && !ai.dead) made++;
            }

            expect(attempts, `${archetype}: no valid setup`).toBeGreaterThan(0);
            expect(made, `${archetype} reached safety only ${made}/${attempts} times`)
                .toBeGreaterThanOrEqual(Math.min(2, attempts));
        }
    }, SIM_TIMEOUT);

    test("an AI running for the circle is never culled mid-flight", () => {
        const game = createGame(TeamMode.Solo, "vietnam");
        game.playerBarn.addTestPlayer({ pos: game.map.center });
        game.started = true;
        game.gas.mode = GameConfig.GasMode.Moving;
        game.gas.currentPos = v2.copy(game.map.center);
        game.gas.currentRad = 70;

        // Beyond the distance cull, which only spares persistent AI.
        let far: Vec2 | undefined;
        for (let a = 0; a < 16; a++) {
            const ang = (a / 16) * Math.PI * 2;
            const p = v2.add(
                game.map.center,
                v2.create(Math.cos(ang) * 160, Math.sin(ang) * 160),
            );
            if (game.map.canPlayerSpawn(p)) { far = p; break; }
        }
        if (!far) return;
        expect(game.aiBarn.spawn("stump_runner", far)).toBe(true);
        const ai = game.aiBarn.controllers[0].player;

        for (let i = 0; i < 600; i++) game.update(0.01);

        // Deleting one mid-run is how "they die in the gas" would still look
        // from the outside even after the fleeing itself was fixed.
        expect(game.playerBarn.players.includes(ai), "culled while fleeing").toBe(true);
    });
});

describe("trees are scenery, not opponents", () => {
    test("killing a tree gives no kill credit and no damage credit", () => {
        const game = createGame(TeamMode.Solo, "vietnam");
        const human = game.playerBarn.addTestPlayer({});
        game.aiBarn.spawn("creeper", game.map.getSpawnPos());
        const ai = game.aiBarn.controllers[0].player;

        ai.damage({
            amount: 20,
            damageType: GameConfig.DamageType.Player,
            dir: v2.randomUnit(),
            source: human,
        });
        expect(human.damageDealt, "damage to trees shouldn't count").toBe(0);

        ai.kill({
            amount: 999,
            damageType: GameConfig.DamageType.Player,
            dir: v2.randomUnit(),
            source: human,
        });

        expect(ai.dead).toBe(true);
        expect(human.kills, "killing a tree isn't a match kill").toBe(0);
        expect(human.killedIds.length).toBe(0);
    });

    test("killing a real player still counts normally", () => {
        const game = createGame(TeamMode.Solo, "vietnam");
        const a = game.playerBarn.addTestPlayer({});
        const b = game.playerBarn.addTestPlayer({});

        b.kill({
            amount: 999,
            damageType: GameConfig.DamageType.Player,
            dir: v2.randomUnit(),
            source: a,
        });

        expect(a.kills).toBe(1);
    });

    test("AI damage is scaled by the configured multiplier", () => {
        const game = createGame(TeamMode.Solo, "vietnam");
        const human = game.playerBarn.addTestPlayer({});
        game.aiBarn.spawn("creeper", game.map.getSpawnPos());
        const ai = game.aiBarn.controllers[0].player;

        const raw = 40;
        human.damage({
            amount: raw,
            damageType: GameConfig.DamageType.Player,
            dir: v2.randomUnit(),
            source: ai,
        });

        const taken = GameConfig.player.health - human.health;
        expect(taken).toBeCloseTo(raw * Config.vietnam.damageMult, 1);
        expect(Config.vietnam.damageMult).toBeLessThan(1);
    });

    test("a player can actually die to AI damage, even at low health", () => {
        // The damage multiplier used to be applied *after* the lethal-damage
        // cap instead of before it: a hit sized to exactly zero out the
        // player's health got that cap computed first, and only then had the
        // multiplier applied to the now-fixed "kill" amount — shrinking a
        // lethal blow into a survivable one. Health approached zero by ever
        // smaller fractions, hit after hit, without ever crossing it: a
        // player at low HP could take fire from a tree forever and never die.
        const game = createGame(TeamMode.Solo, "vietnam");
        const human = game.playerBarn.addTestPlayer({});
        game.aiBarn.spawn("creeper", game.map.getSpawnPos());
        const ai = game.aiBarn.controllers[0].player;

        human.health = 5;
        for (let i = 0; i < 10 && !human.dead; i++) {
            human.damage({
                amount: 40,
                damageType: GameConfig.DamageType.Player,
                dir: v2.randomUnit(),
                source: ai,
            });
        }

        expect(human.dead, "took repeated lethal-sized hits but never died").toBe(true);
    });
});

describe("tuning lives in the server config", () => {
    test("the knobs a server owner would want are editable without a rebuild", () => {
        // survev-config.hjson merges over these, so everything here can be
        // changed on a running deployment.
        for (const key of [
            "enabled",
            "damageMult",
            "seedDensity",
            "maxAlive",
            "baseAlive",
            "perPlayerAlive",
            "spawnIntervalMin",
            "spawnIntervalMax",
            "doorCooldown",
            "gasFleeMargin",
        ] as const) {
            expect(Config.vietnam[key], `Config.vietnam.${key}`).toBeDefined();
        }
    });

    test("disabling the mode in config empties the jungle", () => {
        const original = Config.vietnam.enabled;
        try {
            Config.vietnam.enabled = false;
            const game = createGame(TeamMode.Solo, "vietnam");
            expect(game.aiBarn.enabled).toBe(false);
            game.started = true;
            game.aiBarn.seedInitialAi();
            expect(game.aiBarn.aliveCount).toBe(0);
        } finally {
            Config.vietnam.enabled = original;
        }
    });
});

describe("pathfinding", () => {
    test("routes around solid geometry rather than into it", () => {
        const game = createGame(TeamMode.Solo, "vietnam");
        const nav = game.aiBarn.nav;

        // Try several obstacles: not every one has open ground on both sides at
        // a fixed offset, and that's a property of the map, not the pathfinder.
        let path: Vec2[] | null = null;
        let goal: Vec2 | undefined;
        let tried = 0;

        for (const o of game.map.obstacles) {
            if (o.dead || o.isSkin || !o.collidable || o.isDoor) continue;
            if (o.height < 0.5 || o.layer !== 0) continue;

            const from = v2.add(o.pos, v2.create(-7, 0));
            const to = v2.add(o.pos, v2.create(7, 0));
            if (nav.isBlocked(from) || nav.isBlocked(to)) continue;

            tried++;
            const found = nav.findPath(from, to);
            if (found && found.length > 0) {
                path = found;
                goal = to;
                break;
            }
            if (tried > 40) break;
        }

        expect(path, "no route found past any obstacle on the map").not.toBeNull();

        // Every waypoint must be somewhere a player could actually stand.
        for (const wp of path!) {
            expect(nav.isBlocked(wp), `waypoint ${wp.x},${wp.y} is inside geometry`)
                .toBe(false);
        }

        // The route has to arrive. A blocked goal gets snapped to the nearest
        // open cell, so allow for that rather than demanding an exact landing.
        expect(v2.distance(path![path!.length - 1], goal!)).toBeLessThan(10);
    });

    test("a path query is bounded and never hangs", () => {
        const game = createGame(TeamMode.Solo, "vietnam");
        const nav = game.aiBarn.nav;

        // Opposite corners: far beyond the node budget, so this must give up
        // rather than spin. A pathfinder that can stall a tick is worse than
        // no pathfinder.
        const started = Date.now();
        nav.findPath(v2.create(5, 5), v2.create(game.map.width - 5, game.map.height - 5));
        expect(Date.now() - started).toBeLessThan(250);
    });
});

describe("following players between layers", () => {
    test("an AI notices a player who has dropped below it", () => {
        const game = createGame(TeamMode.Solo, "vietnam");
        const pos = game.map.getSpawnPos();

        const human = game.playerBarn.addTestPlayer({ pos });
        // Same spot, one floor down — a player who has just taken the stairs.
        human.layer = 1;

        expect(game.aiBarn.spawn("creeper", v2.add(pos, v2.create(3, 0)))).toBe(true);
        const controller = game.aiBarn.controllers[0];

        game.step(1.5);

        // Before this, sameLayer checks meant a player two metres below was
        // completely invisible, and AI stood at the top of the stairs doing
        // nothing at all.
        expect(controller.state).not.toBe(AiState.Dormant);
    });

    test("pursuit survives losing sight through a floor", () => {
        const game = createGame(TeamMode.Solo, "vietnam");
        const pos = game.map.getSpawnPos();
        const human = game.playerBarn.addTestPlayer({ pos });
        game.aiBarn.spawn("stump_runner", v2.add(pos, v2.create(6, 0)));

        const controller = game.aiBarn.controllers[0];
        controller.onDamaged(human);
        game.step(1);
        expect(controller.state).not.toBe(AiState.Dormant);

        // Player ducks into a basement: no line of sight, different layer.
        human.layer = 1;
        game.step(8);

        expect(controller.state).not.toBe(AiState.Dormant);
        expect(controller.target).toBeDefined();
    });
});

describe("getting into buildings", () => {
    /** A building with a door and a standable interior. */
    function findEnterableBuilding(game: Game) {
        return game.map.buildings.find((b) =>
            game.map.obstacles.some(
                (o) => o.isDoor && !o.dead && o.layer === 0 && v2.distance(o.pos, b.pos) < 25,
            ) && game.map.canPlayerSpawn(b.pos)
        );
    }

    test("the nav grid can route into a building interior", () => {
        const game = createGame(TeamMode.Solo, "vietnam");
        const nav = game.aiBarn.nav;

        let tested = 0;
        let routed = 0;

        for (const b of game.map.buildings) {
            if (tested >= 8) break;
            const hasDoor = game.map.obstacles.some(
                (o) => o.isDoor && !o.dead && o.layer === 0 && v2.distance(o.pos, b.pos) < 25,
            );
            if (!hasDoor) continue;
            // Skip anything whose interior isn't ground-level walkable — a
            // bunker's rooms live on another layer and aren't routable here.
            if (nav.isBlocked(b.pos)) continue;

            const outside = v2.add(b.pos, v2.create(28, 0));
            if (nav.isBlocked(outside)) continue;

            tested++;
            const path = nav.findPath(outside, b.pos);
            if (path && path.length > 0 && v2.distance(path[path.length - 1], b.pos) < 8) {
                routed++;
            }
        }

        expect(tested, "no building with a door to test").toBeGreaterThan(0);
        // Allowing one miss: the probe comes in from due east, and on a random
        // map that can land across a river or against a solid tree line for a
        // given structure. The claim is that the grid routes into buildings,
        // not that every structure is enterable from one fixed bearing.
        expect(routed, `only routed into ${routed}/${tested} buildings`)
            .toBeGreaterThanOrEqual(tested - 1);
    }, SIM_TIMEOUT);

    test("an AI reaches a player who has gone inside", () => {
        // The reported failure: an AI pacing the outside wall, close to the
        // player but never finding the door. It was walking 300m in 25 seconds
        // and never closing the last eight, because sliding along a wall counts
        // as movement — so the stuck detector never fired and no route was ever
        // requested. Progress toward the goal is what matters, not displacement.
        let reached = 0;
        let tried = 0;

        // Generous on map attempts: whether a given map puts a door-bearing
        // building somewhere an AI can also stand is luck, and running out of
        // attempts is a flaky test rather than a finding.
        for (let t = 0; t < 30 && tried < 4; t++) {
            const game = createGame(TeamMode.Solo, "vietnam");
            const b = findEnterableBuilding(game);
            if (!b) continue;

            const inside = v2.copy(b.pos);
            const outside = v2.add(b.pos, v2.create(22, 0));
            if (!game.map.canPlayerSpawn(outside)) continue;

            const human = game.playerBarn.addTestPlayer({ pos: inside });
            if (!game.aiBarn.spawn("stump_runner", outside)) continue;
            tried++;

            const controller = game.aiBarn.controllers[0];
            controller.onDamaged(human);

            let closest = Infinity;
            for (let i = 0; i < 2500; i++) {
                game.update(0.01);
                closest = Math.min(closest, v2.distance(controller.player.pos, human.pos));
            }
            if (closest < 6) reached++;
        }

        expect(tried, "no suitable building found").toBeGreaterThan(0);
        expect(reached, `only got inside in ${reached}/${tried} attempts`).toBe(tried);
    }, SIM_TIMEOUT);

    test("steering goes around an obstacle rather than grinding into it", () => {
        // Pure repulsion cancels against the heading it opposes. Walking dead-on
        // at a tree produced `desired * (1 - strength)`: pointing at the trunk
        // for anything past touching distance, and pointing backwards inside it.
        // So the AI pressed itself against the trunk, or oscillated in front of
        // it — measured at 15-30% of a chase spent moving with nothing to show
        // for it. A steer perpendicular to the heading can rotate it but never
        // cancel it, which turns contact into sliding past.
        // Deliberately not the Vietnam map. The steering is map-agnostic, and
        // this needs one tree with open ground around it — which the jungle, at
        // roughly 1,500 trunks, reliably does not have anywhere on it. A second
        // trunk off to one side makes the correct answer ambiguous, so the
        // geometry is built rather than hunted for.
        const game = createGame(TeamMode.Solo, "main");
        let clear: Vec2 | undefined;
        for (let x = 60; x < game.map.width - 60 && !clear; x += 9) {
            for (let y = 60; y < game.map.height - 60 && !clear; y += 9) {
                const candidate = v2.create(x, y);
                if (!game.map.canPlayerSpawn(candidate)) continue;
                const near = game.grid.intersectCollider(
                    collider.createCircle(candidate, 7),
                );
                const solid = near.some(
                    (n) =>
                        n.__type === ObjectType.Obstacle
                        && !n.dead
                        && !n.isSkin
                        && n.collidable,
                );
                if (!solid) clear = candidate;
            }
        }
        expect(clear, "nowhere on the map with 7m of open ground").toBeDefined();

        const tree = game.map.genObstacle("tree_07", clear!);
        const aabb = collider.toAabb(tree.collider);
        const radius = (aabb.max.x - aabb.min.x) / 2;

        // Standing just clear of the trunk, walking straight at its centre.
        const walker = game.playerBarn.addTestPlayer({ pos: clear! });
        v2.set(walker.pos, v2.add(tree.pos, v2.create(-(radius + 1.2), 0)));

        const desired = v2.create(1, 0);
        const steered = avoidObstacles(game, walker, desired);

        expect(
            Math.abs(steered.y),
            `steered ${steered.x.toFixed(2)},${steered.y.toFixed(2)} — straight at the trunk`,
        ).toBeGreaterThan(0.4);
        expect(steered.x, "backed away instead of going around").toBeGreaterThan(0);

        // And it must leave a heading alone when nothing is in the way, or an AI
        // would weave its way across the map. Same spot, walking off the other
        // way: the trunk is now behind and has no business steering anything.
        expect(avoidObstacles(game, walker, v2.create(-1, 0)))
            .toEqual(v2.create(-1, 0));
    });

    test("a blocked straight line is detected without walking into it", () => {
        const game = createGame(TeamMode.Solo, "vietnam");
        const nav = game.aiBarn.nav;

        const wall = game.map.obstacles.find(
            (o) =>
                !o.dead && !o.isSkin && o.collidable && !o.isDoor && o.height >= 0.5
                && o.layer === 0,
        );
        expect(wall).toBeDefined();

        // Straight through the middle of something solid.
        const from = v2.add(wall!.pos, v2.create(-4, 0));
        const to = v2.add(wall!.pos, v2.create(4, 0));
        expect(nav.isLineClear(from, to)).toBe(false);

        // And a line that touches nothing must not report blocked.
        expect(nav.isLineClear(from, v2.add(from, v2.create(0.5, 0)))).toBe(true);
    });
});

describe("throwables", () => {
    test("every AI carries exactly one throwable type", () => {
        const game = createGame(TeamMode.Solo, "vietnam");
        const pool = Object.keys(MapDefs.vietnam.gameMode.ai!.throwablePool);
        const seen = new Set<string>();

        for (let i = 0; i < 60; i++) {
            game.aiBarn.spawn("creeper", game.map.getSpawnPos());
        }

        for (const c of game.aiBarn.controllers) {
            const type = c.player.weapons[GameConfig.WeaponSlot.Throwable].type;
            expect(type, "an AI spawned with no throwable").toBeTruthy();
            expect(pool, `${type} isn't in the pool`).toContain(type);
            expect(c.player.invManager.get(type as never)).toBeGreaterThan(0);
            seen.add(type);
        }

        // The pool is meant to produce variety, not one grenade for everyone.
        expect(seen.size).toBeGreaterThan(2);
    });

    test("the pool only contains real throwables", () => {
        for (const name of Object.keys(MapDefs.vietnam.gameMode.ai!.throwablePool)) {
            expect(name, `${name} in throwablePool`).toBeValidGameObj("throwable");
        }
    });

    test("cover does not end the fight", () => {
        // The reported worry: a player steps behind a wall and the AI is out of
        // options. It has two, and this asserts it always takes one of them.
        //
        // Which one is not the interesting part, and pinning it was a mistake
        // this test made for a while. It demanded a grenade every time, so when
        // the AI was taught to stop throwing at people it could simply walk up
        // to and shoot — the fix that stopped it lobbing frags mid-chase and
        // losing 25m of ground per throw — this failed while the behaviour got
        // better. Flushing and pushing are both answers to cover. Standing
        // outside doing neither is the bug.
        let answered = 0;
        let tried = 0;

        for (let t = 0; t < 16 && tried < 4; t++) {
            const game = createGame(TeamMode.Solo, "vietnam");

            // A spot where the building genuinely breaks line of sight.
            let inside: Vec2 | undefined;
            let outside: Vec2 | undefined;
            for (const b of game.map.buildings) {
                if (inside) break;
                if (!game.map.canPlayerSpawn(b.pos)) continue;
                for (let a = 0; a < 8 && !inside; a++) {
                    const ang = (a / 8) * Math.PI * 2;
                    const out = v2.add(
                        b.pos,
                        v2.create(Math.cos(ang) * 14, Math.sin(ang) * 14),
                    );
                    if (!game.map.canPlayerSpawn(out)) continue;
                    if (hasLineOfSight(game, out, b.pos, 0)) continue;
                    inside = v2.copy(b.pos);
                    outside = out;
                }
            }
            if (!inside || !outside) continue;

            const human = game.playerBarn.addTestPlayer({ pos: inside });
            if (!game.aiBarn.spawn("creeper", outside)) continue;
            tried++;

            const controller = game.aiBarn.controllers[0];
            const ai = controller.player;
            ai.weaponManager.setWeapon(GameConfig.WeaponSlot.Throwable, "frag", 0);
            ai.invManager.set("frag" as never, 5);
            controller.onDamaged(human);

            let resolved = false;
            for (let i = 0; i < 1500 && !resolved; i++) {
                game.update(0.01);
                if (game.projectileBarn.projectiles.length > 0) resolved = true;
                else if (
                    v2.distance(ai.pos, human.pos) < 30
                    && hasLineOfSight(game, ai.pos, human.pos, ai.layer)
                ) resolved = true;
            }
            if (resolved) answered++;
        }

        expect(tried, "no enclosing building found").toBeGreaterThan(0);
        expect(answered, `did nothing about cover in ${tried - answered}/${tried}`)
            .toBe(tried);
    }, SIM_TIMEOUT);

    test("an AI with a clear shot doesn't waste grenades", () => {
        const game = createGame(TeamMode.Solo, "vietnam");
        const pair = placeFacingPair(game, "creeper", 12);
        expect(pair).toBeDefined();

        pair!.ai.weaponManager.setWeapon(GameConfig.WeaponSlot.Throwable, "frag", 0);
        pair!.ai.invManager.set("frag" as never, 5);

        for (let i = 0; i < 300; i++) game.update(0.01);

        // Out in the open with line of sight, shooting is simply better.
        expect(pair!.ai.invManager.get("frag" as never)).toBe(5);
    });

    test("an AI never blows itself up with its own grenade", () => {
        // Holding the fire input on a throwable is not "throw", it is "cook",
        // and the weapon manager only forces the throw once the cook has run
        // past the fuse. Holding it for the cooldown between grenades therefore
        // detonated every frag in the AI's hands. Measured before the fix: the
        // hunter killed itself in 11 of 25 nine-second chases, which reads from
        // the player's side as trees that inexplicably stop coming after you.
        //
        // Explosions specifically, rather than all self-harm: the jungle is full
        // of barrels, and bullets bounce off those, so an AI clipping itself for
        // a few points on a ricochet is ordinary play. A hundred and twenty-five
        // points of frag damage from a grenade it was holding is not.
        let selfKills = 0;
        let selfBlasts = 0;
        let tried = 0;

        for (let t = 0; t < 12; t++) {
            const game = createGame(TeamMode.Solo, "vietnam");
            const start = game.map.getSpawnPos();
            const human = game.playerBarn.addTestPlayer({ pos: start });
            if (!game.aiBarn.spawn("stump_runner", v2.add(start, v2.create(8, 0)))) {
                continue;
            }
            tried++;

            const ai = game.aiBarn.controllers[0].player;
            const damage = ai.damage.bind(ai);
            let blastsHere = 0;
            ai.damage = (params) => {
                if (params.source === ai && params.isExplosion) blastsHere++;
                return damage(params);
            };

            // The player runs, which is what makes the AI throw in the first place.
            human.moveRight = true;
            for (let i = 0; i < 900; i++) {
                game.update(0.01);
                if (human.dead) break;
            }
            selfBlasts += blastsHere;
            if (ai.dead && blastsHere > 0) selfKills++;
        }

        // Nothing in this scenario can hurt the AI except the AI: the human
        // never fires, and no other archetype is targeting it.
        expect(tried, "could not place an AI anywhere").toBeGreaterThan(0);
        expect(selfKills, `blew itself up in ${selfKills}/${tried} chases`).toBe(0);
        expect(selfBlasts, `caught its own blast ${selfBlasts} times`).toBe(0);
    }, SIM_TIMEOUT);

    test("a thrown grenade still has fuse left on it", () => {
        // The other half of the same bug. Holding the input past the fuse is a
        // grenade at your own feet; releasing with the whole four seconds still
        // on it gives the target long enough to walk out of the blast, which
        // makes flushing anybody out of anywhere impossible.
        //
        // The target is underground and nowhere near a staircase, so there is
        // nothing the AI can do with its feet that produces a shot. That is the
        // one situation a grenade is unambiguously the answer to — given a way
        // in, it takes the way in instead, which the stairs tests cover.
        let fuse = -1;
        let tried = 0;

        for (let t = 0; t < 10 && tried < 6 && fuse < 0; t++) {
            const game = createGame(TeamMode.Solo, "vietnam");
            const spot = game.map.getSpawnPos();
            const aiPos = v2.add(spot, v2.create(16, 0));
            if (!game.map.canPlayerSpawn(aiPos)) continue;

            const human = game.playerBarn.addTestPlayer({ pos: spot });
            human.layer = 1;
            if (!game.aiBarn.spawn("creeper", aiPos)) continue;
            tried++;

            const controller = game.aiBarn.controllers[0];
            const ai = controller.player;
            ai.weaponManager.setWeapon(GameConfig.WeaponSlot.Throwable, "frag", 0);
            ai.invManager.set("frag" as never, 10);
            controller.onDamaged(human);

            for (let i = 0; i < 600 && fuse < 0; i++) {
                game.update(0.01);
                const mine = game.projectileBarn.projectiles.find(
                    (p) => p.playerId === ai.__id,
                );
                if (mine) fuse = mine.fuseTime;
            }
        }

        const def = GameObjectDefs.typeToDef("frag", "throwable");
        expect(tried, "could not set up a target below").toBeGreaterThan(0);
        expect(fuse, "never threw at a target it cannot possibly shoot")
            .toBeGreaterThanOrEqual(0);
        expect(fuse, "released with no fuse left — that is a grenade at your feet")
            .toBeGreaterThan(1);
        expect(fuse, "released without cooking at all").toBeLessThan(def.fuseTime);
    }, SIM_TIMEOUT);

    test("an AI gets out of the radius of a live grenade", () => {
        // Including its own. A hunter that throws a frag fifteen metres ahead of
        // a fleeing player and then sprints after them at twelve metres a second
        // arrives exactly as the fuse ends. The grenade here is put deliberately
        // between the AI and the player it is chasing, so "keep chasing" and
        // "get clear" pull in opposite directions and only one of them can win.
        const game = createGame(TeamMode.Solo, "vietnam");
        const pair = placeFacingPair(game, "stump_runner", 16);
        expect(pair).toBeDefined();

        const ai = pair!.ai;
        const controller = game.aiBarn.controllers.find((c) => c.player === ai)!;
        controller.onDamaged(pair!.human);
        for (let i = 0; i < 60; i++) game.update(0.01);

        const toHuman = v2.normalizeSafe(
            v2.sub(pair!.human.pos, ai.pos),
            v2.create(1, 0),
        );
        const origin = v2.add(ai.pos, v2.mul(toHuman, 3));

        // Thrown by the human, so none of the AI's own throw logic is involved.
        game.projectileBarn.addProjectile(
            pair!.human.__id,
            "frag",
            origin,
            0,
            ai.layer,
            v2.create(0, 0),
            5,
            0,
        );

        let closest = v2.distance(ai.pos, origin);
        for (let i = 0; i < 200; i++) {
            game.update(0.01);
            closest = Math.min(closest, v2.distance(ai.pos, origin));
        }

        const ended = v2.distance(ai.pos, origin);
        // A frag does full damage inside 5m. Walking onto it because the player
        // happens to be on the other side is not a trade anything alive makes.
        expect(closest, `closed to ${closest.toFixed(1)}m of a live frag`)
            .toBeGreaterThan(2);
        expect(ended, `ended ${ended.toFixed(1)}m from a live frag`).toBeGreaterThan(8);
    }, SIM_TIMEOUT);

    test("firing into something that bounces bullets back is recognised", () => {
        // Barrels, containers and every metal wall in the game are flagged
        // `reflectBullets`, and a reflected bullet is explicitly allowed to
        // damage whoever fired it.
        const game = createGame(TeamMode.Solo, "vietnam");

        // One with no other reflector near it, so the negative case below is
        // testing what it says it is.
        const barrel = game.map.obstacles.find((o) => {
            if (o.dead || !o.collidable || !o.type.startsWith("barrel_")) return false;
            const near = game.grid.intersectCollider(collider.createCircle(o.pos, 9));
            return !near.some(
                (n) =>
                    n !== o
                    && n.__type === ObjectType.Obstacle
                    && !n.dead
                    && !n.isSkin
                    && n.collidable
                    && MapObjectDefs.typeToDef(n.type, "obstacle").reflectBullets,
            );
        });
        expect(barrel, "no isolated barrel on this map").toBeDefined();

        const from = v2.add(barrel!.pos, v2.create(-4, 0));
        const through = v2.add(barrel!.pos, v2.create(4, 0));
        expect(ricochetRisk(game, from, through, 0)).toBe(true);

        // And a line that touches nothing reflective must not report a risk,
        // or the AI would simply stop shooting.
        expect(ricochetRisk(game, from, v2.add(from, v2.create(0, -0.5)), 0)).toBe(false);
    });
});

describe("following a player underground", () => {
    /** A structure with a real (non-loot) staircase. */
    function findStairs(game: Game) {
        for (const st of game.map.structures) {
            const stair = st.stairs.find((x) => !x.lootOnly);
            if (stair) return stair;
        }
        return undefined;
    }

    test("an AI does not shoot itself to pieces on the way downstairs", () => {
        // A bunker is metal on every side, and metal is flagged `reflectBullets`
        // — a reflected bullet is explicitly allowed to damage whoever fired it.
        // An AI that shot at a player two metres away in a stairwell filled the
        // corridor with its own buckshot: measured at 69 self-inflicted hits in
        // a single descent, dying at the bottom, with the player never firing.
        // Following somebody downstairs is only useful if you arrive alive.
        let selfHits = 0;
        let tried = 0;

        for (let t = 0; t < 8 && tried < 4; t++) {
            const game = createGame(TeamMode.Solo, "vietnam");
            const stair = findStairs(game);
            if (!stair) continue;

            const down = v2.add(
                stair.downAabb.min,
                v2.mul(v2.sub(stair.downAabb.max, stair.downAabb.min), 0.5),
            );
            const surface = v2.add(down, v2.create(20, 0));
            if (!game.map.canPlayerSpawn(surface)) continue;

            const human = game.playerBarn.addTestPlayer({ pos: down });
            human.layer = 1;
            if (!game.aiBarn.spawn("creeper", surface)) continue;
            tried++;

            const controller = game.aiBarn.controllers[0];
            const ai = controller.player;
            const damage = ai.damage.bind(ai);
            ai.damage = (params) => {
                if (params.source === ai && !params.isExplosion) selfHits++;
                return damage(params);
            };
            controller.onDamaged(human);

            for (let i = 0; i < 2000; i++) {
                game.update(0.01);
                if (human.dead) break;
            }
        }

        expect(tried, "no staircase found").toBeGreaterThan(0);
        // The human never fires, so every one of these came off its own gun.
        // A stray bounce is fine; a corridor full of them is the bug.
        expect(selfHits, `shot itself ${selfHits} times over ${tried} descents`)
            .toBeLessThan(4 * tried);
    }, SIM_TIMEOUT);

    test("an AI takes the stairs after a player who goes below", () => {
        // The reported failure: a player drops into a basement and the AI stands
        // on the surface directly above them. Walking at someone underground is
        // walking at the ceiling — the goal has to be the staircase.
        let descended = 0;
        let tried = 0;

        for (let t = 0; t < 6 && tried < 3; t++) {
            const game = createGame(TeamMode.Solo, "vietnam");
            const stair = findStairs(game);
            if (!stair) continue;

            const down = v2.add(
                stair.downAabb.min,
                v2.mul(v2.sub(stair.downAabb.max, stair.downAabb.min), 0.5),
            );

            const human = game.playerBarn.addTestPlayer({
                pos: v2.add(down, v2.mul(stair.downDir, 6)),
            });
            human.layer = 1;

            const surface = v2.add(down, v2.mul(stair.downDir, -18));
            if (!game.map.canPlayerSpawn(surface)) continue;
            if (!game.aiBarn.spawn("stump_runner", surface)) continue;
            tried++;

            const controller = game.aiBarn.controllers[0];
            controller.onDamaged(human);

            let wentUnder = false;
            for (let i = 0; i < 3000 && !wentUnder; i++) {
                game.update(0.01);
                if (controller.player.layer === 1) wentUnder = true;
            }
            if (wentUnder) descended++;
        }

        expect(tried, "no staircase to test with").toBeGreaterThan(0);
        expect(descended, `only descended in ${descended}/${tried} attempts`)
            .toBe(tried);
    }, SIM_TIMEOUT);

    test("an AI on the stairs commits rather than backing off", () => {
        // Standing on a staircase counts as sharing a layer with everything, so
        // an AI that reached the top step used to acquire the player below,
        // switch to Engage, and retreat to its preferred range — walking back
        // out of the stairwell it had just found.
        const game = createGame(TeamMode.Solo, "vietnam");
        const stair = (() => {
            for (const st of game.map.structures) {
                const s2 = st.stairs.find((x) => !x.lootOnly);
                if (s2) return s2;
            }
            return undefined;
        })();
        if (!stair) return;

        const down = v2.add(
            stair.downAabb.min,
            v2.mul(v2.sub(stair.downAabb.max, stair.downAabb.min), 0.5),
        );
        const human = game.playerBarn.addTestPlayer({
            pos: v2.add(down, v2.mul(stair.downDir, 6)),
        });
        human.layer = 1;

        const surface = v2.add(down, v2.mul(stair.downDir, -18));
        if (!game.map.canPlayerSpawn(surface)) return;
        if (!game.aiBarn.spawn("stump_runner", surface)) return;

        const controller = game.aiBarn.controllers[0];
        controller.onDamaged(human);

        let reachedStairs = false;
        let thenLeft = false;
        for (let i = 0; i < 3000; i++) {
            game.update(0.01);
            const layer = controller.player.layer;
            if (layer === 2 || layer === 3) reachedStairs = true;
            if (reachedStairs && layer === 1) break;
            if (reachedStairs && layer === 0) thenLeft = true;
        }

        expect(reachedStairs, "never reached the staircase").toBe(true);
        expect(controller.player.layer, "should have ended up below").toBe(1);
        expect(thenLeft && controller.player.layer !== 1).toBe(false);
    }, SIM_TIMEOUT);
});
