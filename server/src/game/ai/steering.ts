import { ObjectType } from "../../../../shared/net/objectSerializeFns.ts";
import { collider } from "../../../../shared/utils/collider.ts";
import { util } from "../../../../shared/utils/util.ts";
import { v2, type Vec2 } from "../../../../shared/utils/v2.ts";
import type { Game } from "../game.ts";
import type { Player } from "../objects/player.ts";

/** How far ahead the AI looks for things to walk around. */
const AVOID_RADIUS = 3.5;
/** Diagonal movement needs both axes past this, so use a value under 1/sqrt(2). */
const MOVE_DEADZONE = 0.25;
/** Range error below this counts as "at the right distance" — see combatMove. */
const RANGE_DEADBAND = 0.15;
/** Range error at which the AI is fully committed to closing rather than orbiting. */
const RANGE_COMMIT = 0.35;

/**
 * Translate a desired direction into the four movement booleans the game's own
 * input path uses.
 *
 * Everything downstream — acceleration, collision, water, stairs — is then the
 * game's ordinary movement code, so an AI is subject to exactly the same
 * physics as a human. Pass `null` to stand perfectly still, which is what
 * DORMANT does and is the reason a sleeping enemy is indistinguishable from
 * real scenery.
 */
export function setMoveDir(player: Player, dir: Vec2 | null): void {
    if (!dir) {
        player.moveLeft = false;
        player.moveRight = false;
        player.moveUp = false;
        player.moveDown = false;
        return;
    }

    const n = v2.normalizeSafe(dir, v2.create(0, 0));

    player.moveRight = n.x > MOVE_DEADZONE;
    player.moveLeft = n.x < -MOVE_DEADZONE;
    player.moveUp = n.y > MOVE_DEADZONE;
    player.moveDown = n.y < -MOVE_DEADZONE;
}

/** How much of the steer is "go around" versus "back off". */
const TANGENT_WEIGHT = 1.6;
const RADIAL_WEIGHT = 0.35;
/** Below this the obstacle is dead ahead and the side has to be picked. */
const HEAD_ON_EPSILON = 0.08;

/**
 * Nudge a desired heading around nearby solid obstacles.
 *
 * This is deliberately steering, not pathfinding. The Vietnam map is ~95% open
 * jungle with scattered trees, where going around is indistinguishable from a
 * real path and costs a tiny fraction as much; A* is the fallback for what it
 * can't solve.
 *
 * Two details are what make it work in a forest this dense, and both were
 * measured rather than guessed.
 *
 * Clearance is to the obstacle's *surface*, through the same collider
 * intersection the movement code uses, not to its centre. A tree_07 and a bush
 * are metres apart in size, so centre distance says nothing about whether you
 * are about to walk into one, and a building's AABB has no useful centre at all.
 *
 * The steer is mostly *tangential* — perpendicular to where you wanted to go —
 * rather than a straight push back. Pure repulsion cancels against the heading
 * it opposes: walking at a trunk dead-on produced `desired * (1 - strength)`,
 * which is zero at touching distance and negative inside it, so the AI ground
 * itself against the tree and then oscillated. A perpendicular steer can only
 * rotate a heading, never cancel it, so contact turns into sliding past.
 * Measured over 30 nine-second chases through the jungle, the ticks an AI spent
 * pressed against something making no progress fell from 15-30% to near zero.
 */
export function avoidObstacles(game: Game, ai: Player, desired: Vec2): Vec2 {
    const query = collider.createCircle(ai.pos, AVOID_RADIUS);
    const objs = game.grid.intersectCollider(query);

    // Left-hand normal of the heading. The tangential steer lives on this axis.
    const perp = v2.perp(desired);
    // Stable per-AI tie-break for a perfectly head-on obstacle, so it commits to
    // one side for the whole encounter rather than re-deciding every tick.
    const tieBreak = ai.__id % 2 === 0 ? 1 : -1;

    let tangent = 0;
    let radial = v2.create(0, 0);
    let hits = 0;

    for (let i = 0; i < objs.length; i++) {
        const obj = objs[i];
        if (obj.__type !== ObjectType.Obstacle) continue;
        if (obj.dead || obj.isSkin || !obj.collidable) continue;
        if (!util.sameLayer(obj.layer, ai.layer)) continue;
        // A closed door is a gate to open, not terrain to route around — the
        // navgrid already treats it as passable for exactly this reason (see
        // navGrid.ts). Without this, local avoidance disagreed with the path
        // it was steering along: it kept peeling the AI off before it ever
        // got within the door's precise interaction range, so the door-open
        // check at the heart of `_handleDoors` never saw it close enough to
        // trigger — measured at over a third of doorway approaches simply
        // never opening the door at all, not just opening it slowly.
        if (obj.isDoor) continue;

        // `dir` points from the obstacle's surface toward us; `pen` is how far
        // inside the look-ahead circle that surface reaches.
        const hit = collider.intersectCircle(obj.collider, ai.pos, AVOID_RADIUS);
        if (!hit) continue;

        const toObstacle = v2.neg(hit.dir);
        const ahead = v2.dot(toObstacle, desired);
        // Only steer around things we're actually heading into, otherwise the
        // AI weaves away from scenery it was already clear of.
        if (ahead <= 0.2) continue;

        const strength = Math.min(1, hit.pen / AVOID_RADIUS) * ahead;

        // Positive means the obstacle sits to our left, so peel off to the right.
        const side = v2.dot(perp, toObstacle);
        const away = Math.abs(side) < HEAD_ON_EPSILON ? tieBreak : -Math.sign(side);

        tangent += away * strength;
        radial = v2.add(radial, v2.mul(hit.dir, strength));
        hits++;
    }

    if (hits === 0) return desired;

    const steered = v2.add(
        v2.add(desired, v2.mul(perp, (TANGENT_WEIGHT * tangent) / hits)),
        v2.mul(radial, RADIAL_WEIGHT / hits),
    );
    return v2.normalizeSafe(steered, desired);
}

/**
 * A direction perpendicular to the line to the target, for circle-strafing.
 * `sign` flips which way around.
 */
export function strafeDir(toTarget: Vec2, sign: number): Vec2 {
    return v2.mul(v2.perp(v2.normalizeSafe(toTarget)), sign);
}

/**
 * Blend approach and strafe so the AI closes to `preferredRange` while orbiting
 * rather than walking down the barrel of the player's gun.
 *
 * The deadband matters: without it an AI hovering near its preferred range
 * flips between "advance" and "back off" every time it drifts across the
 * threshold, and because movement is quantised into four booleans that reads on
 * screen as a jitter rather than as a decision.
 */
export function combatMove(
    toTarget: Vec2,
    dist: number,
    preferredRange: number,
    strafeSign: number,
): Vec2 {
    const approach = v2.normalizeSafe(toTarget);
    const strafe = strafeDir(toTarget, strafeSign);

    // Positive = too far and should close, negative = too close and should back off.
    const rangeError = (dist - preferredRange) / Math.max(preferredRange, 1);

    if (Math.abs(rangeError) < RANGE_DEADBAND) {
        // At the right distance: pure orbit.
        return v2.normalizeSafe(strafe, approach);
    }

    // Commit fully to closing or backing off as soon as you're meaningfully out
    // of position, rather than easing into it.
    //
    // Ramping approach linearly with range error meant that at 20m from a 14m
    // preferred range the AI wanted to approach at 0.43 while still strafing at
    // 0.85 — so most of its movement was sideways and it closed at 2.8 u/s
    // against a player running away at 13. A chase has to look like a chase.
    const urgency = Math.min(1, Math.abs(rangeError) / RANGE_COMMIT);
    const approachWeight = Math.sign(rangeError) * urgency;

    // Strafing is what you do in a firefight you're already in; it costs you the
    // chase if you're still trying to get there.
    const strafeWeight = 0.85 * (1 - urgency) + 0.15 * urgency;

    return v2.normalizeSafe(
        v2.add(v2.mul(approach, approachWeight), v2.mul(strafe, strafeWeight)),
        approach,
    );
}

/**
 * Rotate `from` toward `to` by at most `maxRadians`.
 *
 * AI write their facing into the same field a mouse would, and a mouse does not
 * teleport. Turning at a bounded rate is what stops a disguised enemy from
 * looking like it is vibrating while it tracks a moving player.
 */
export function rotateToward(from: Vec2, to: Vec2, maxRadians: number): Vec2 {
    const a = v2.normalizeSafe(from);
    const b = v2.normalizeSafe(to);

    const dot = Math.max(-1, Math.min(1, v2.dot(a, b)));
    const angle = Math.acos(dot);
    if (angle <= maxRadians || angle < 1e-4) return b;

    // v2.perp gives the left-hand normal, so its dot with the target tells us
    // which way round the shorter arc runs.
    const sign = v2.dot(v2.perp(a), b) >= 0 ? 1 : -1;
    return v2.rotate(a, maxRadians * sign);
}

/**
 * Size of the aim error cone, shrinking the longer the AI has held the target.
 *
 * The caller samples an offset from this once per shot rather than once per
 * tick. Resampling every tick both looks wrong (the enemy vibrates) and plays
 * wrong, because a shot's accuracy then depends on which tick it happened to
 * land on rather than on how long the AI has been tracking.
 */
export function aimErrorSpread(
    timeOnTarget: number,
    errorMax: number,
    errorMin: number,
    tightenTime: number,
): number {
    const t = tightenTime <= 0 ? 1 : Math.min(1, timeOnTarget / tightenTime);
    return errorMax + (errorMin - errorMax) * t;
}
