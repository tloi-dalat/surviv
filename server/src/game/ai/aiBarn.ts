import {
    type AiArchetype,
    type AiModeConfig,
    getAiDef,
    isAiArchetype,
} from "../../../../shared/defs/gameObjects/aiDefs.ts";
import { GameObjectDefs } from "../../../../shared/defs/register.ts";
import type { GunDef } from "../../../../shared/defs/gameObjects/gunDefs.ts";
import { GameConfig, type InventoryItem } from "../../../../shared/gameConfig.ts";
import { util } from "../../../../shared/utils/util.ts";
import { v2, type Vec2 } from "../../../../shared/utils/v2.ts";
import { Config } from "../../config.ts";
import type { Game } from "../game.ts";
import type { Player } from "../objects/player.ts";
import { AiController } from "./aiController.ts";
import { JungleDirector } from "./jungleDirector.ts";
import { NavGrid } from "./navGrid.ts";
import { isValidTarget, type NoiseEvent } from "./perception.ts";

/** How long a gunshot stays audible to dormant AI. */
const NOISE_TTL = 1.5;

/**
 * Owns every AI entity in a Vietnam-mode match: spawning, culling, pacing and
 * the per-tick controller updates.
 *
 * The whole system is inert on every other map — `enabled` is false unless the
 * map def opts in, and `update()` returns immediately.
 */
export class AiBarn {
    readonly game: Game;
    readonly enabled: boolean;
    readonly config?: AiModeConfig;
    readonly director?: JungleDirector;

    readonly controllers: AiController[] = [];

    /** Gunshots and explosions heard this window. */
    private _noises: NoiseEvent[] = [];

    /** Living non-AI players, rebuilt once per tick and shared by all controllers. */
    private _humans: Player[] = [];

    /**
     * Spawns that had nowhere valid to go. Held rather than dropped, so a player
     * who denied the director a spawn point by staying in the open gets a bigger
     * wave once they move back into cover. Straight out of L4D's mob queue.
     */
    private _queued = 0;

    private _spawnTimer = 0;
    private _bossSpawned = false;
    private _seeded = false;

    /** Bunker/tunnel entrances, preferred spawn points. Filled after map gen. */
    readonly spawnAnchors: Vec2[] = [];

    /**
     * Built once on first use and shared by every AI. Steering handles open
     * ground; this is the fallback for when steering is stuck against a tree
     * cluster or a building it can't feel its way around.
     */
    private _nav?: NavGrid;

    get nav(): NavGrid {
        this._nav ??= new NavGrid(this.game);
        return this._nav;
    }

    constructor(game: Game) {
        this.game = game;

        const config = game.map.mapDef.gameMode.ai;
        this.enabled = !!(game.map.vietnamMode && config?.enabled && Config.vietnam.enabled);
        this.config = config;

        if (this.enabled && config) {
            this.director = new JungleDirector(game, config);
            this._spawnTimer = Config.vietnam.spawnIntervalMin;
        }
    }

    get aliveCount(): number {
        return this.controllers.length;
    }

    /**
     * Register a sound dormant AI can react to. Called from the weapon manager
     * on every shot; harmless and cheap on non-Vietnam maps because `enabled`
     * short-circuits it.
     */
    onNoise(pos: Vec2, layer: number, loudness = 1): void {
        if (!this.enabled) return;
        if (this.controllers.length === 0) return;
        this._noises.push({ pos: v2.copy(pos), layer, loudness, ttl: NOISE_TTL });
    }

    update(dt: number): void {
        if (!this.enabled || !this.config || !this.director) return;

        //
        // Age out noise events
        //
        for (let i = this._noises.length - 1; i >= 0; i--) {
            this._noises[i].ttl -= dt;
            if (this._noises[i].ttl <= 0) this._noises.splice(i, 1);
        }

        this.director.update(dt);

        //
        // Built once and shared by every controller. Each AI used to filter
        // playerBarn.livingPlayers itself, which on a seeded map is mostly other
        // AI — so perception cost grew with the square of the jungle rather than
        // with the number of players who can actually be seen.
        //
        this._humans.length = 0;
        const living = this.game.playerBarn.livingPlayers;
        for (let i = 0; i < living.length; i++) {
            if (isValidTarget(living[i])) this._humans.push(living[i]);
        }

        //
        // Drive every AI
        //
        for (let i = this.controllers.length - 1; i >= 0; i--) {
            const controller = this.controllers[i];
            if (controller.player.dead) {
                this.controllers.splice(i, 1);
                continue;
            }
            controller.update(dt, this._noises, this._humans);
        }

        if (!this.game.started) return;

        this._cullDistantAi();
        this._updateSpawning(dt);
        this._maybeSpawnBoss();
    }

    /**
     * Seed the jungle when the match starts.
     *
     * These are placed across the entire map rather than relative to any player,
     * because they are meant to be already in position when players arrive — the
     * ambush you walk into while looting, not a reinforcement sent after you.
     * They are marked persistent so the distance cull leaves them alone.
     *
     * The count is derived from land area the same way densitySpawns are, so a
     * duel map gets proportionally fewer rather than the same number crammed
     * into a quarter of the space.
     */
    seedInitialAi(): void {
        if (!this.enabled || !this.config || this._seeded) return;
        this._seeded = true;

        const map = this.game.map;
        const target = Math.round(Config.vietnam.seedDensity * (map.shoreArea / 250000));
        let spawned = 0;

        for (let attempt = 0; attempt < target * 40 && spawned < target; attempt++) {
            const pos = v2.create(
                util.random(map.shoreInset, map.width - map.shoreInset),
                util.random(map.shoreInset, map.height - map.shoreInset),
            );
            if (!map.canPlayerSpawn(pos)) continue;

            if (this.spawn(this._pickArchetype(), pos)) {
                this.controllers[this.controllers.length - 1].persistent = true;
                spawned++;
            }
        }

        this.game.logger.info(
            `[jungle] seeded ${spawned}/${target} AI across ${
                Math.round(map.shoreArea / 1000)
            }k units of jungle`,
        );
    }

    /** Director reinforcements currently alive, excluding the seeded population. */
    get reinforcementCount(): number {
        let count = 0;
        for (let i = 0; i < this.controllers.length; i++) {
            if (!this.controllers[i].persistent) count++;
        }
        return count;
    }

    /**
     * Create one AI: a headless Player wearing the archetype's costume outfit.
     *
     * Because it is a real Player, it inherits movement, collision, the weapon
     * system, damage, death, loot and — critically — the existing client
     * serialisation, so the client needs to know nothing about AI at all.
     */
    spawn(archetype: AiArchetype, pos: Vec2): boolean {
        if (!this.enabled) return false;
        if (!isAiArchetype(archetype)) return false;

        const def = getAiDef(archetype);

        const player = this.game.playerBarn.addAiPlayer(archetype, pos, 0);
        if (!player) return false;

        player.aiMaxHealth = def.health;
        player.health = def.health;

        // The costume is the whole trick: setOutfit spawns the disguise obstacle
        // and wires up skinPlayerId, all of which already existed.
        //
        // Which costume is chosen at random from the map's pool rather than
        // fixed per role, so a bush might be the sniper and a tree might be the
        // one that charges you. The silhouette tells the player nothing.
        const outfit = util.weightedRandomObject(this.config!.disguisePool);
        player.setOutfit(outfit);

        //
        // Arm it. Clip sizes come from the gun def so AI reloads match players'.
        //
        const gunType = util.weightedRandomObject(
            Object.fromEntries(def.weapons.map((w) => [w.type, w.weight])),
        );
        const gunDef = GameObjectDefs.typeToDefSafe(gunType) as GunDef | undefined;

        if (gunDef?.type === "gun") {
            player.weaponManager.setWeapon(
                GameConfig.WeaponSlot.Primary,
                gunType,
                gunDef.maxClip,
            );
            player.invManager.set(gunDef.ammo as InventoryItem, gunDef.maxClip * 4);
            player.weaponManager.setCurWeapIndex(GameConfig.WeaponSlot.Primary);
        }

        // Fists, always.
        //
        // The melee slot is what an AI holds while dormant, precisely so no gun
        // barrel pokes out of the foliage. Every melee weapon in the game except
        // fists renders its own world sprite, so arming them with a machete or
        // an axe reintroduces exactly the problem that stowing the gun solved —
        // a blade sticking out of a bush, visible from across the map.
        //
        // Fists still hit for 24 (scaled by Config.vietnam.damageMult), which is
        // what swings when a player is standing on top of them.
        player.weaponManager.setWeapon(GameConfig.WeaponSlot.Melee, "fists", 0);

        // One throwable type each, drawn at random. A grenade doesn't care about
        // line of sight, so this is what stops a building from being a solved
        // problem for the player. Harassers carry double.
        const throwable = util.weightedRandomObject(this.config!.throwablePool);
        if (throwable && GameObjectDefs.typeToDefSafe(throwable)?.type === "throwable") {
            const count = Config.vietnam.throwableCount
                * (def.behaviour === "harass" ? 2 : 1);
            player.invManager.set(throwable as InventoryItem, count);
            player.weaponManager.showNextThrowable();
        }

        const controller = new AiController(player, archetype);
        controller.outfit = outfit;
        player.aiController = controller;
        // Spawns dormant, so the gun goes away immediately — otherwise a freshly
        // seeded bush stands there visibly holding a rifle.
        controller.stowWeapon();
        this.controllers.push(controller);

        return true;
    }

    /**
     * Called from Player.kill for AI. Drops the archetype's bonus loot and
     * detonates anything that explodes on death.
     */
    onAiDeath(player: Player, killer?: Player): void {
        if (!this.enabled) return;
        const controller = player.aiController;
        if (!controller) return;

        const def = controller.def;

        this.director?.onAiKilled(player.pos, killer);

        for (const entry of def.loot) {
            if (Math.random() > entry.odds) continue;
            for (let i = 0; i < entry.count; i++) {
                const item = this.game.lootBarn.getLootTable(entry.tier);
                if (!item?.name) continue;
                this.game.lootBarn.addLoot(item.name, player.pos, player.layer, item.count, {
                    pushSpeed: util.random(7.5, 11),
                    dir: v2.randomUnit(),
                });
            }
        }

        // The costume itself, occasionally — so a player can wear the jungle's
        // own disguise. Rare on purpose: it should be a story, not a strategy.
        if (Math.random() < 0.08 && controller.outfit) {
            this.game.lootBarn.addLoot(controller.outfit, player.pos, player.layer, 1, {
                pushSpeed: util.random(7.5, 11),
                dir: v2.randomUnit(),
            });
        }

        if (def.explodeOnDeath) {
            this.game.projectileBarn.addSplitProjectiles(
                player.__id,
                def.explodeOnDeath.type,
                player.pos,
                player.layer,
                v2.create(0, 0),
                def.explodeOnDeath.count,
                def.explodeOnDeath.rad,
            );
        }

        util.removeFrom(this.controllers, controller);
        this.game.playerBarn.releaseAiGroupId(player);
    }

    //
    // Internals
    //

    private _pickArchetype(): AiArchetype {
        const weights = this.config!.archetypeWeights;
        const picked = util.weightedRandomObject(weights);
        return isAiArchetype(picked) ? picked : "creeper";
    }

    private _aliveHumans(): number {
        let count = 0;
        const players = this.game.playerBarn.livingPlayers;
        for (let i = 0; i < players.length; i++) {
            if (isValidTarget(players[i])) count++;
        }
        return count;
    }

    private _updateSpawning(dt: number): void {
        const director = this.director!;

        this._spawnTimer -= dt;
        if (this._spawnTimer > 0) return;

        this._spawnTimer = util.random(
            Config.vietnam.spawnIntervalMin,
            Config.vietnam.spawnIntervalMax,
        ) / director.escalationMult();

        const humans = this._aliveHumans();
        if (humans === 0) return;

        // Seeded AI don't count against the director's budget — they're part of
        // the map, not part of the pressure it's metering out.
        const cap = director.currentCap(humans);
        const room = cap - this.reinforcementCount;
        if (room <= 0) return;

        // Release the backlog first, but never more than the cap allows.
        const want = Math.min(room, 1 + this._queued);

        let spawned = 0;
        for (let i = 0; i < want; i++) {
            const pos = director.findSpawnPos(this.spawnAnchors);
            if (!pos) break;
            if (this.spawn(this._pickArchetype(), pos)) spawned++;
        }

        if (spawned === 0) {
            // Nowhere valid — queue it rather than silently dropping the pressure.
            this._queued = Math.min(this._queued + 1, 6);
        } else {
            this._queued = Math.max(0, this._queued - spawned);
        }
    }

    private _maybeSpawnBoss(): void {
        const boss = this.config!.boss;
        if (!boss || this._bossSpawned) return;
        if (this.game.gas.circleIdx < boss.circleIdx) return;
        if (!isAiArchetype(boss.archetype)) return;

        const pos = this.director!.findSpawnPos(this.spawnAnchors);
        if (!pos) return;

        if (this.spawn(boss.archetype, pos)) {
            this._bossSpawned = true;
            this.game.logger.info(`[jungle] boss ${boss.archetype} spawned`);
        }
    }

    /**
     * Cull AI that have drifted far from every living player. Keeps the working
     * set near the action instead of paying full freight for enemies nobody can
     * reach. Dormant-only, so a player never sees one wink out mid-fight.
     */
    private _cullDistantAi(): void {
        const despawnDist = this.config!.director.despawnDist;
        const humans = this.game.playerBarn.livingPlayers.filter(isValidTarget);
        if (humans.length === 0) return;

        for (let i = this.controllers.length - 1; i >= 0; i--) {
            const controller = this.controllers[i];
            // The seeded population is the map's, not the director's. Culling it
            // would mean the far side of the map quietly emptied out before
            // anyone got there.
            if (controller.persistent) continue;
            if (!controller.isDormant) continue;
            // Fleeing the gas counts as doing something, even though the state
            // machine still says dormant. Deleting one mid-run is how "they die
            // in the gas" would look from the outside even after it was fixed.
            //
            // Tested against the gas directly rather than the controller flag,
            // because culling can run before an AI's first think tick — so a
            // freshly spawned one hadn't yet worked out that it was fleeing.
            if (controller.isFleeingGas) continue;
            if (
                this.game.gas.mode !== GameConfig.GasMode.Inactive
                && this.game.gas.isInGas(controller.player.pos)
            ) {
                continue;
            }

            let nearest = Infinity;
            for (let j = 0; j < humans.length; j++) {
                const dist = v2.distance(humans[j].pos, controller.player.pos);
                if (dist < nearest) nearest = dist;
            }

            if (nearest <= despawnDist) continue;

            this.controllers.splice(i, 1);
            this.despawn(controller.player);
        }
    }

    /** Remove an AI without going through death, loot or the killfeed. */
    despawn(player: Player): void {
        this.game.playerBarn.releaseAiGroupId(player);
        this.game.playerBarn.removePlayer(player);
        util.removeFrom(this.game.clientBarn.clients, player.client);
    }
}
