import type { AiArchetypeDef } from "../../../../shared/defs/gameObjects/aiDefs.ts";
import { MapObjectDefs } from "../../../../shared/defs/register.ts";
import { ObjectType } from "../../../../shared/net/objectSerializeFns.ts";
import { collider } from "../../../../shared/utils/collider.ts";
import { util } from "../../../../shared/utils/util.ts";
import { v2, type Vec2 } from "../../../../shared/utils/v2.ts";
import type { Game } from "../game.ts";
import type { Player } from "../objects/player.ts";

/**
 * Obstacles shorter than this don't block line of sight. Bushes sit well under
 * it, which is deliberate: foliage conceals (you can't tell what's in it) but
 * does not blind (bullets and eyes pass through). Trees, walls and containers
 * are above it and do block.
 */
const LOS_BLOCK_HEIGHT = 0.5;

/** A gunshot or explosion the AI can hear. Produced by {@link AiBarn.onNoise}. */
export interface NoiseEvent {
    pos: Vec2;
    layer: number;
    /** 1 = a normal gunshot. Scales the listener's hearRadius. */
    loudness: number;
    /** Seconds remaining before this event is forgotten. */
    ttl: number;
}

/**
 * True if nothing solid sits between `from` and `to`.
 *
 * Skin obstacles (the AI's own disguises, and disguised players') are ignored —
 * they are non-collidable decoration and treating them as cover would let a
 * crowd of AI blind each other.
 */
export function hasLineOfSight(game: Game, from: Vec2, to: Vec2, layer: number): boolean {
    const objs = game.grid.intersectLineSegment(from, to);

    for (let i = 0; i < objs.length; i++) {
        const obj = objs[i];
        if (obj.__type !== ObjectType.Obstacle) continue;
        if (obj.dead || obj.isSkin || !obj.collidable) continue;
        if (obj.height < LOS_BLOCK_HEIGHT) continue;
        if (!util.sameLayer(obj.layer, layer)) continue;
        if (collider.intersectSegment(obj.collider, from, to)) return false;
    }

    return true;
}

/**
 * True if firing along this line would put a bullet into something that sends
 * it straight back.
 *
 * Barrels, shipping containers and every metal wall in the game are flagged
 * `reflectBullets`, and a reflected bullet is explicitly allowed to damage the
 * player who fired it. Standing in a bunker stairwell shooting at somebody two
 * metres away therefore fills the corridor with your own buckshot: measured at
 * 69 self-inflicted hits and a dead AI in a single twenty-second descent, which
 * looks from the outside like the tree that followed you downstairs quietly
 * dying for no reason.
 *
 * Only worth checking at close range — a ricochet is halved on the bounce and
 * decays with distance, so it stops mattering well before the length of a room.
 * Learning not to shoot the wall you're standing against is a thing people do
 * in their first hour of this game.
 */
export function ricochetRisk(
    game: Game,
    from: Vec2,
    to: Vec2,
    layer: number,
): boolean {
    const objs = game.grid.intersectLineSegment(from, to);

    for (let i = 0; i < objs.length; i++) {
        const obj = objs[i];
        if (obj.__type !== ObjectType.Obstacle) continue;
        if (obj.dead || obj.isSkin || !obj.collidable) continue;
        if (!util.sameLayer(obj.layer, layer)) continue;

        const def = MapObjectDefs.typeToDef(obj.type, "obstacle");
        if (!def.reflectBullets) continue;
        if (collider.intersectSegment(obj.collider, from, to)) return true;
    }

    return false;
}

/** True if `target` lies inside `viewer`'s cone. A fov of 360 always passes. */
export function inFov(viewDir: Vec2, from: Vec2, to: Vec2, fovDeg: number): boolean {
    if (fovDeg >= 360) return true;
    const toTarget = v2.sub(to, from);
    if (v2.lengthSqr(toTarget) < 0.0001) return true;
    const dot = v2.dot(viewDir, v2.normalizeSafe(toTarget));
    return dot >= Math.cos((fovDeg / 2) * (Math.PI / 180));
}

/** Players an AI is allowed to consider. Excludes other AI, so they never infight. */
export function isValidTarget(p: Player): boolean {
    return !p.dead && !p.disconnected && !p.isAI;
}

/**
 * Pick the best target for an awake AI: nearest valid player that is in range,
 * in the field of view, and visible.
 *
 * `players` is the living-human list the AiBarn builds once per tick. Filtering
 * `livingPlayers` here instead would mean every AI re-walking a list that is
 * mostly other AI — quadratic in the size of the jungle.
 *
 * Returns undefined when nothing qualifies, which sends the controller back
 * toward DORMANT after its `loseTargetTime` elapses.
 */
export function findTarget(
    game: Game,
    ai: Player,
    def: AiArchetypeDef,
    range: number,
    players: Player[],
): Player | undefined {
    let best: Player | undefined;
    let bestDistSqr = range * range;

    for (let i = 0; i < players.length; i++) {
        const p = players[i];
        if (!util.sameLayer(p.layer, ai.layer)) continue;

        const distSqr = v2.lengthSqr(v2.sub(p.pos, ai.pos));
        if (distSqr > bestDistSqr) continue;

        if (!inFov(ai.dir, ai.pos, p.pos, def.senses.fovDeg)) continue;
        if (!hasLineOfSight(game, ai.pos, p.pos, ai.layer)) continue;

        bestDistSqr = distSqr;
        best = p;
    }

    return best;
}

/**
 * Should a dormant AI wake up?
 *
 * Three independent triggers, in cost order — the cheap proximity check runs
 * first because the overwhelming majority of dormant ticks fail it and return
 * immediately, which is what keeps a map full of sleeping enemies affordable.
 *
 * The third trigger (a player staring at it) exists so a suspicious player
 * can't neutralise an ambush just by watching a bush from a safe distance.
 */
export function shouldWake(
    game: Game,
    ai: Player,
    def: AiArchetypeDef,
    noises: NoiseEvent[],
    stareTimer: number,
    dt: number,
    players: Player[],
    checkStare: boolean,
): { wake: boolean; target?: Player; stareTime: number } {
    // 1. proximity
    let nearest: Player | undefined;
    let nearestDistSqr = Infinity;
    const wakeSqr = def.senses.wakeRadius * def.senses.wakeRadius;

    for (let i = 0; i < players.length; i++) {
        const p = players[i];

        const distSqr = v2.lengthSqr(v2.sub(p.pos, ai.pos));

        // Someone on the other side of a floor can still be heard, just not as
        // far. Without this an AI standing at the top of a stairwell had no idea
        // a player was two metres below it.
        if (!util.sameLayer(p.layer, ai.layer)) {
            if (distSqr > wakeSqr * 0.36) continue;
        }

        if (distSqr < nearestDistSqr) {
            nearestDistSqr = distSqr;
            nearest = p;
        }
    }

    if (nearest && nearestDistSqr <= wakeSqr) {
        const crossLayer = !util.sameLayer(nearest.layer, ai.layer);
        if (crossLayer || hasLineOfSight(game, ai.pos, nearest.pos, ai.layer)) {
            return { wake: true, target: nearest, stareTime: 0 };
        }
    }

    // 2. noise
    for (let i = 0; i < noises.length; i++) {
        const noise = noises[i];
        // Gunfire carries through a floor, just not as far.
        const sameLayer = util.sameLayer(noise.layer, ai.layer);
        const radius = def.senses.hearRadius * noise.loudness * (sameLayer ? 1 : 0.5);
        if (v2.lengthSqr(v2.sub(noise.pos, ai.pos)) <= radius * radius) {
            return { wake: true, target: nearest, stareTime: 0 };
        }
    }

    // 3. being stared at.
    //
    // This is the only trigger that needs a line-of-sight raycast on a dormant
    // AI, and raycasts are by far the most expensive thing the perception code
    // does. On a seeded map with a full lobby almost every AI has somebody
    // within range, so running it on every think tick dominated the AI budget.
    // The caller throttles it and hands us the accumulated time instead, which
    // keeps stareTimeout meaning the same number of seconds.
    const stareRangeSqr = (def.senses.wakeRadius * 2.5) ** 2;
    if (checkStare && nearest && nearestDistSqr <= stareRangeSqr) {
        const looksAtUs = inFov(nearest.dir, nearest.pos, ai.pos, 50)
            && hasLineOfSight(game, nearest.pos, ai.pos, ai.layer);

        if (looksAtUs) {
            const newStare = stareTimer + dt;
            return {
                wake: newStare >= def.senses.stareTimeout,
                target: nearest,
                stareTime: newStare,
            };
        }
    }

    return { wake: false, stareTime: 0 };
}
