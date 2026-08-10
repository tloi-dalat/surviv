import type { AiModeConfig } from "../../../../shared/defs/gameObjects/aiDefs.ts";
import { util } from "../../../../shared/utils/util.ts";
import { v2, type Vec2 } from "../../../../shared/utils/v2.ts";
import { Config } from "../../config.ts";
import type { Game } from "../game.ts";
import type { Player } from "../objects/player.ts";
import { isValidTarget } from "./perception.ts";

/**
 * Per-player pacing state. Deliberately mirrors Left 4 Dead's Director: an
 * intensity value that climbs under pressure and decays out of contact, plus a
 * relax window after every peak during which nothing is allowed to spawn near
 * that player.
 *
 * The relax phase is not a nicety. Without it players learn within one match
 * that every bush is hostile, and the moment that happens the disguise stops
 * working and the mode collapses into a bad wave shooter. The quiet is what
 * makes the next ambush land.
 */
interface PlayerPacing {
    intensity: number;
    /** Seconds of enforced quiet remaining around this player. */
    relaxTimer: number;
    /** True while intensity is above the peak threshold. */
    peaked: boolean;
}

export class JungleDirector {
    readonly game: Game;
    readonly config: AiModeConfig;

    private _pacing = new Map<number, PlayerPacing>();

    constructor(game: Game, config: AiModeConfig) {
        this.game = game;
        this.config = config;
    }

    private _for(player: Player): PlayerPacing {
        let pacing = this._pacing.get(player.__id);
        if (!pacing) {
            pacing = { intensity: 0, relaxTimer: 0, peaked: false };
            this._pacing.set(player.__id, pacing);
        }
        return pacing;
    }

    update(dt: number): void {
        const cfg = this.config.director;

        for (const player of this.game.playerBarn.livingPlayers) {
            if (!isValidTarget(player)) continue;

            const pacing = this._for(player);

            pacing.intensity = Math.max(0, pacing.intensity - cfg.intensityDecay * dt);

            if (!pacing.peaked && pacing.intensity >= cfg.peakThreshold) {
                pacing.peaked = true;
            }

            // Coming down off a peak opens the relax window.
            if (pacing.peaked && pacing.intensity < cfg.peakThreshold * 0.4) {
                pacing.peaked = false;
                pacing.relaxTimer = util.random(
                    cfg.relaxDurationMin,
                    cfg.relaxDurationMax,
                );
                this.game.logger.debug?.(
                    `[jungle] relax window opened for ${player.name}`,
                );
            }

            if (pacing.relaxTimer > 0) {
                pacing.relaxTimer = Math.max(0, pacing.relaxTimer - dt);
            }
        }

        // Drop pacing state for players who have left.
        if (this._pacing.size > this.game.playerBarn.livingPlayers.length * 2 + 8) {
            const alive = new Set(
                this.game.playerBarn.livingPlayers.map((p) => p.__id),
            );
            for (const id of this._pacing.keys()) {
                if (!alive.has(id)) this._pacing.delete(id);
            }
        }
    }

    /** Damage taken is the strongest signal that a player is under pressure. */
    onPlayerDamaged(player: Player, amount: number): void {
        if (!isValidTarget(player)) return;
        const pacing = this._for(player);
        pacing.intensity = Math.min(100, pacing.intensity + amount * 0.9);
    }

    /**
     * Killing an AI at close range is stressful; picking one off at distance is
     * not. L4D makes the same distinction, and it matters — without it, a
     * careful sniper gets throttled as hard as someone being overrun.
     */
    onAiKilled(pos: Vec2, killer?: Player): void {
        if (!killer || !isValidTarget(killer)) return;
        const dist = v2.distance(pos, killer.pos);
        if (dist > 25) return;
        const pacing = this._for(killer);
        pacing.intensity = Math.min(100, pacing.intensity + 12 * (1 - dist / 25));
    }

    intensityOf(player: Player): number {
        return this._pacing.get(player.__id)?.intensity ?? 0;
    }

    /** False while this player is peaked or inside their relax window. */
    acceptsSpawnsNear(player: Player): boolean {
        const pacing = this._for(player);
        if (pacing.relaxTimer > 0) return false;
        return pacing.intensity < this.config.director.peakThreshold;
    }

    /** Live cap, scaled to how many humans are actually left alive. */
    currentCap(aliveHumans: number): number {
        const cfg = Config.vietnam;
        const scaled = cfg.baseAlive + cfg.perPlayerAlive * aliveHumans;
        return Math.floor(Math.min(cfg.maxAlive, scaled));
    }

    /** Spawn density rises as the gas closes and the play space shrinks. */
    escalationMult(): number {
        const circleIdx = this.game.gas.circleIdx;
        let mult = 1;
        for (const step of this.config.escalation) {
            if (circleIdx >= step.circleIdx) mult = step.densityMult;
        }
        return mult;
    }

    /**
     * Find somewhere to put a new enemy.
     *
     * The rules, in order of how much they matter:
     *  - never inside anybody's view (that's a pop-in, and it reads as a cheat)
     *  - never inside the gas, or it dies before it does anything
     *  - close enough to the action to be relevant within a minute
     *  - near a bunker entrance where possible, so enemies read as emerging
     *    from tunnels rather than materialising
     *
     * Returns undefined when nothing qualifies. The caller queues the spawn
     * rather than dropping it, so pressure the player dodged now arrives later
     * and larger.
     */
    findSpawnPos(anchors: Vec2[]): Vec2 | undefined {
        const cfg = this.config.director;
        const map = this.game.map;
        const humans = this.game.playerBarn.livingPlayers.filter(isValidTarget);

        if (humans.length === 0) return undefined;

        // Only consider players who aren't in a relax window.
        const candidates = humans.filter((p) => this.acceptsSpawnsNear(p));
        if (candidates.length === 0) return undefined;

        const focus = util.randomItem(candidates);

        const isValidPos = (pos: Vec2): boolean => {
            if (pos.x < 1 || pos.y < 1 || pos.x > map.width - 1 || pos.y > map.height - 1) {
                return false;
            }
            if (this.game.gas.isInGas(pos)) return false;
            if (!map.canPlayerSpawn(pos)) return false;

            for (let i = 0; i < humans.length; i++) {
                const dist = v2.distance(humans[i].pos, pos);
                if (dist < cfg.minSpawnDist) return false;
            }

            return v2.distance(focus.pos, pos) <= cfg.maxSpawnDist;
        };

        // Prefer a tunnel mouth in the right band around the focus player.
        const usableAnchors = anchors.filter(isValidPos);
        if (usableAnchors.length > 0 && Math.random() < 0.6) {
            return v2.copy(util.randomItem(usableAnchors));
        }

        // Otherwise scatter in a ring around them.
        for (let attempt = 0; attempt < 40; attempt++) {
            const angle = Math.random() * Math.PI * 2;
            const dist = util.random(cfg.minSpawnDist, cfg.maxSpawnDist);
            const pos = v2.add(
                focus.pos,
                v2.create(Math.cos(angle) * dist, Math.sin(angle) * dist),
            );
            if (isValidPos(pos)) return pos;
        }

        return undefined;
    }
}
