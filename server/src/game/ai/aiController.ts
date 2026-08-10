import {
    type AiArchetype,
    type AiArchetypeDef,
    getAiDef,
} from "../../../../shared/defs/gameObjects/aiDefs.ts";
import { ExplosionDefs } from "../../../../shared/defs/gameObjects/explosionsDefs.ts";
import { GameObjectDefs } from "../../../../shared/defs/register.ts";
import { GameConfig, type InventoryItem } from "../../../../shared/gameConfig.ts";
import { ObjectType } from "../../../../shared/net/objectSerializeFns.ts";
import { collider } from "../../../../shared/utils/collider.ts";
import { util } from "../../../../shared/utils/util.ts";
import { v2, type Vec2 } from "../../../../shared/utils/v2.ts";
import { Config } from "../../config.ts";
import type { Game } from "../game.ts";
import type { Obstacle } from "../objects/obstacle.ts";
import type { Player } from "../objects/player.ts";
import {
    findTarget,
    hasLineOfSight,
    type NoiseEvent,
    ricochetRisk,
    shouldWake,
} from "./perception.ts";
import {
    aimErrorSpread,
    avoidObstacles,
    combatMove,
    rotateToward,
    setMoveDir,
} from "./steering.ts";

/**
 * Perception runs at 10 Hz rather than the game's 100 Hz tick. Line-of-sight
 * raycasts are by far the most expensive thing an AI does and they do not need
 * to be resolved ten times inside a single human reaction. Movement and aim
 * still update every tick, so nothing looks choppy.
 */
const THINK_INTERVAL = 0.1;

/**
 * Movement multiplier during the rustle telegraph. Small enough that the AI
 * barely travels, large enough that the disguise obstacle — whose position the
 * client interpolates from the player — visibly shudders. That shudder is the
 * player's entire warning, so it is applied even to archetypes with
 * `speedMult: 0`, which are otherwise rooted.
 */
const RUSTLE_SPEED_MULT = 0.14;
/** How often the rustle flips direction. Lower = more of a shiver. */
const RUSTLE_OSCILLATION = 0.07;

/**
 * Maximum turn rate while awake, radians per second. AI write their facing into
 * the same field a mouse would, so it has to move like a hand moves — a 180°
 * turn takes roughly half a second here. Snapping instantly makes a disguised
 * enemy read as vibrating rather than aiming.
 */
const TURN_RATE = 7;
/** Aim error is resampled at most this often, and additionally on every shot. */
const AIM_RESAMPLE_INTERVAL = 0.5;
/**
 * How often a dormant AI checks whether somebody is staring at it. This is the
 * only dormant trigger that costs a raycast, and a third of a second is well
 * inside human reaction time for a mechanic measured in seconds.
 */
const STARE_CHECK_INTERVAL = 0.3;

/** Movement below this per think tick, while trying to move, counts as stuck. */
const STUCK_EPSILON = 0.05;
/** Seconds of no progress before the AI tries to do something about it. */
const STUCK_TIMEOUT = 0.4;
/** How long a sidestep lasts once the AI decides to go around something. */
const SIDESTEP_DURATION = 0.9;
/** Reach for opening doors and for finding whatever is blocking the way. */
const INTERACT_RANGE = 3.5;
/** Give up on shooting through an obstacle after this long and go around. */
const BREACH_TIMEOUT = 4;
/**
 * Progress toward the goal below this over PROGRESS_WINDOW counts as "getting
 * nowhere", even if the AI is moving flat out.
 *
 * Measuring raw displacement was the bug behind AI pacing around the outside of
 * a house: sliding along a wall is movement, so the stuck detector never fired
 * and a route was never requested. They walked 300m in 25 seconds and never
 * closed the last eight.
 */
const PROGRESS_EPSILON = 1.5;
const PROGRESS_WINDOW = 1.2;
/**
 * How far a rooted archetype may drift from where it spawned. It needs enough
 * slack to shuffle out from under a player standing on it, and no more — a
 * "static" enemy that has wandered ten metres is just a slow chaser.
 */
const ROOTED_LEASH = 3;

/**
 * Throwing window. Below the minimum you blow yourself up; above it the grenade
 * lands short, because throw distance is capped by the game's own
 * `throwableMaxMouseDist`.
 */
const THROW_MIN_RANGE = 8;
const THROW_MAX_RANGE = 22;
/**
 * Distance to hold while a throw is imminent. A frag does full damage inside
 * 5m and still hurts out to 12, so walking to a bush's preferred 5m range and
 * then lobbing one is suicide — and pressing against the wall of a building you
 * can't shoot into is what made throwing never fire at all.
 *
 * Only applied while the throw is actually coming up, so between grenades the
 * AI still closes and comes through the door.
 */
const THROW_STANDOFF = 11;
const THROW_IMMINENT = 1.5;
/** How long sight has to stay broken before a grenade is the right answer. */
const THROW_UNSEEN_TIME = 1.5;
/**
 * How long the AI holds a cookable grenade before releasing it.
 *
 * This exists because holding the fire input is not "throw" — it is "cook", and
 * the weapon manager only force-throws once the cook has run past the fuse.
 * Setting the hold to the *cooldown* between grenades, as this first did, meant
 * every frag was held for its full four-second fuse and detonated in the AI's
 * hands: measured at 11 self-kills in 25 nine-second chases, which read from
 * the outside as trees that randomly stop chasing you.
 *
 * A short cook is still worth keeping rather than releasing instantly. A frag
 * thrown with the whole fuse left gives the target four seconds to walk out of
 * the blast, which makes flushing somebody out of a doorway impossible.
 */
const COOK_TIME_MIN = 0.5;
const COOK_TIME_MAX = 1.1;
/**
 * Leave at least this much fuse at release, whatever the cook maths says. It is
 * the margin between "cooked a grenade well" and "held a grenade too long".
 */
const MIN_FUSE_AT_RELEASE = 2;
/**
 * Extra clearance beyond an explosion's own outer radius before the AI is happy
 * standing there. Grenades bounce, and the AI is running while it decides.
 */
const BLAST_MARGIN = 3;
/** How often the stairwell search re-runs. It walks every structure on the map. */
const STAIR_SEARCH_INTERVAL = 1;

/**
 * Inside this range the AI stops trying to shoot and switches to melee.
 *
 * Bullets spawn at the end of the barrel, roughly a metre and a half ahead of
 * the shooter, so a player standing on top of an AI is behind every shot it
 * fires. Without this, hugging a tree was a completely safe way to kill it.
 */
const PANIC_RANGE = 3.5;
/**
 * The actual reach of an unarmed swing — how far the fists melee hitbox
 * extends from the player's own centre. Derived straight from that def
 * (offset + radius) instead of a second hardcoded number, so it can't drift
 * out of sync with the weapon it describes.
 *
 * This is deliberately smaller than PANIC_RANGE: PANIC_RANGE also covers the
 * band where a target is too close for *bullets* to spawn clear of the
 * shooter, which is wider than fist reach. In the steady-state Engage combat
 * loop that gap is harmless — combatMove's orbit/approach dynamics don't let
 * an AI linger at a fixed distance from a target for long. But the gas-flee
 * branch drives movement purely off "run toward safety", with no relation to
 * the target's position, so it can get stuck in that dead zone — swinging
 * at air, never falling through to check whether a shot is possible —
 * relative to a stationary target for as long as the flee lasts. Anywhere a
 * melee trigger isn't backstopped by that self-correcting movement, gate it
 * on real reach instead of PANIC_RANGE.
 */
const FIST_REACH = (() => {
    const fists = GameObjectDefs.typeToDef("fists", "melee");
    return fists.attack.offset.x + fists.attack.rad;
})();
/**
 * How far ahead to look for something that would bounce a bullet back. Beyond
 * this a ricochet is halved and distance-decayed into irrelevance.
 */
const RICOCHET_GUARD = 5;
/**
 * Speed granted to otherwise-rooted archetypes while a player is inside their
 * footprint, so "I cannot move" never means "I am a free kill". Enough to
 * shuffle out of the hug, not enough to reposition like a mobile archetype.
 */
const ROOTED_ESCAPE_SPEED = 0.5;

/**
 * How long to hold this throwable before letting go, in seconds.
 *
 * Non-cookable items (smoke, strobe) are released immediately: their fuse does
 * not start until they land, so holding one achieves nothing except standing
 * still. Cookables are held briefly and never past `MIN_FUSE_AT_RELEASE`.
 */
function cookTimeFor(type: string): number {
    const def = GameObjectDefs.typeToDefSafe(type);
    if (!def || def.type !== "throwable" || !def.cookable) return 0;
    return Math.min(util.random(COOK_TIME_MIN, COOK_TIME_MAX), def.fuseTime - MIN_FUSE_AT_RELEASE);
}

/**
 * The radius inside which this projectile is worth caring about, or 0 if it
 * can't hurt anybody. Read off the explosion def rather than hardcoded, so a
 * strobe's small pop and a smoke's harmlessness are both respected.
 *
 * Explosion damage is full inside `rad.min` and falls to nothing at `rad.max`,
 * so the midpoint is roughly where it stops mattering — a frag at 8.5m does
 * about a quarter of its damage. The margin on top is for the fact that
 * grenades bounce and everyone involved is moving.
 *
 * This single number does double duty: it is both the distance an AI runs out
 * of, and the closest it is willing to throw. Deriving one from the other is
 * what stops the AI from throwing a grenade into a zone it will then flee.
 */
function blastRadiusOf(type: string): number {
    const def = GameObjectDefs.typeToDefSafe(type);
    if (!def || def.type !== "throwable" || !def.explosionType) return 0;
    const boom = ExplosionDefs[def.explosionType];
    if (!boom || boom.damage <= 0) return 0;
    return (boom.rad.min + boom.rad.max) / 2 + BLAST_MARGIN;
}

/** Closest this AI will throw the given item: never inside its own blast. */
function minThrowRange(type: string): number {
    return Math.max(THROW_MIN_RANGE, blastRadiusOf(type) + 1);
}

export enum AiState {
    /**
     * Perfectly still. Writes no movement, holds its spawn facing, never fires.
     * A dormant AI is visually identical to a real obstacle of the same type.
     */
    Dormant,
    /** Telegraph window. Shudders in place, still forbidden from firing. */
    Rustle,
    /** Awake, has a last-known position, moving to re-acquire. */
    Stalk,
    /** Has line of sight and is shooting. */
    Engage,
    /** Hurt or out of ammo; breaks contact and re-hides. */
    Retreat,
}

export class AiController {
    readonly player: Player;
    readonly archetype: AiArchetype;
    readonly def: AiArchetypeDef;
    readonly game: Game;

    state = AiState.Dormant;

    /** Where it spawned. Ambushers drift back here after losing a target. */
    readonly homePos: Vec2;

    /**
     * Seeded as part of the map at match start, rather than sent in by the
     * director. Persistent AI are never culled for being far from a player —
     * they are the ambush that is *supposed* to be waiting in the far corner.
     */
    persistent = false;

    target?: Player;
    lastKnownTargetPos?: Vec2;

    private _thinkAccum = 0;
    private _stateTimer = 0;
    private _stareTimer = 0;
    /** Time banked since the last stare check — see STARE_CHECK_INTERVAL. */
    private _stareAccum = 0;
    /** Seconds of continuous line of sight, used to tighten the aim cone. */
    private _timeOnTarget = 0;
    private _timeSinceSeen = 0;
    /**
     * Seconds since the AI last actually had eyes on the target, as distinct
     * from `_timeSinceSeen`, which is time since it lost track of them
     * altogether. A player standing behind a wall two metres away is still very
     * much tracked, and it is exactly that case a grenade is for.
     */
    private _timeSinceLos = 0;

    private _strafeSign = Math.random() < 0.5 ? 1 : -1;
    private _strafeTimer = 0;

    private _burstRemaining = 0;
    private _burstPause = 0;
    /** Previous tick's clip count, used to count shots that actually left the gun. */
    private _lastAmmo = -1;
    private _lastAmmoSlot = -1;

    /**
     * Starts short and random so the first grenade lands during the approach.
     * At the old flat 3s an AI had already crossed 45m and was against the wall
     * before it was allowed to throw anything.
     */
    private _throwTimer = Math.random() * 1.5 + 0.5;
    /** Seconds left to hold a grenade that is currently being cooked. */
    private _cookTimer = 0;
    /** True while scrambling out of the radius of a live explosive. */
    private _fleeingBlast = false;
    /** Living humans this tick, supplied by the AiBarn. */
    private _humans: Player[] = [];

    /** The costume this one happens to be wearing. Chosen at spawn, not by role. */
    outfit = "";

    //
    // Pursuit and unsticking
    //
    /** Where it's headed when it has lost the target and is sweeping for them. */
    private _searchGoal?: Vec2;
    private _searchTimer = 0;
    /** Position at the last think tick, for detecting a lack of progress. */
    private _stuckRef: Vec2;
    private _stuckTimer = 0;
    /** Non-zero while going around something; sign picks which way. */
    private _sidestepSign = 0;
    private _sidestepTimer = 0;
    /** An obstacle in the way that the AI has decided to shoot through. */
    private _breachTarget?: { pos: Vec2; id: number };
    private _breachTimer = 0;
    /**
     * Seconds before this AI will touch a door again. Without it they reopen a
     * door the instant you shut it, which reads as a glitch rather than as an
     * opponent — a person would at least pause.
     */
    private _doorCooldown = 0;
    /** True while running for the circle; overrides everything else. */
    private _fleeingGas = false;

    /** Waypoints from the nav grid, used only while steering can't cope. */
    private _path: Vec2[] = [];
    private _pathGoal?: Vec2;
    private _pathCooldown = 0;
    /** Consecutive stuck events; two in a row means steering isn't going to work. */
    private _stuckStrikes = 0;
    /** Distance to the goal when progress was last sampled. */
    private _progressRef = Infinity;
    private _progressTimer = 0;
    /** Where the gas is pushing us, when it is. */
    private _gasGoal?: Vec2;
    /** Cached stairwell to use when the target is on another floor. */
    private _stairGoal?: Vec2;
    /** Far side of the chosen staircase, used once we're standing on it. */
    private _stairExit?: Vec2;
    private _stairTimer = 0;
    /** Target is too close for bullets to work — see PANIC_RANGE. */
    private _pointBlank = false;

    /** Current facing, eased toward `_aimTarget` at TURN_RATE. */
    private _aimDir: Vec2;
    /** Where the AI wants to be pointing, including its current error offset. */
    private _aimTarget: Vec2;
    /**
     * Movement is decided on the think tick and held between them. Recomputing
     * it every tick makes the four movement booleans flicker, which shows up on
     * screen as a shaking bush.
     */
    private _desiredMove: Vec2 | null = null;
    private _aimErrorOffset = 0;
    private _aimErrorTimer = 0;

    constructor(player: Player, archetype: AiArchetype) {
        this.player = player;
        this.archetype = archetype;
        this.def = getAiDef(archetype);
        this.game = player.game;
        this.homePos = v2.copy(player.pos);
        this._aimDir = v2.copy(player.dir);
        this._aimTarget = v2.copy(player.dir);
        this._stuckRef = v2.copy(player.pos);
    }

    get isDormant(): boolean {
        return this.state === AiState.Dormant;
    }

    /** True while abandoning everything to run for the safe zone. */
    get isFleeingGas(): boolean {
        return this._fleeingGas;
    }

    update(dt: number, noises: NoiseEvent[], humans: Player[]): void {
        if (this.player.dead) return;

        this._humans = humans;

        this._thinkAccum += dt;
        if (this._thinkAccum >= THINK_INTERVAL) {
            const thinkDt = this._thinkAccum;
            this._thinkAccum = 0;
            this._think(thinkDt, noises);
            this._plan();
        }

        this._act(dt);
    }

    /** Perception and state transitions. Runs at THINK_INTERVAL. */
    private _think(dt: number, noises: NoiseEvent[]): void {
        this._stateTimer += dt;

        if (
            this.state === AiState.Stalk
            || this.state === AiState.Engage
            || this.state === AiState.Retreat
        ) {
            this._updateStairGoal(dt);
            this._updateNavigation(dt);
        }

        switch (this.state) {
            case AiState.Dormant:
                this._thinkDormant(dt, noises);
                break;
            case AiState.Rustle:
                if (this._stateTimer >= this.def.combat.reactionDelay) {
                    this._enter(this.target ? AiState.Engage : AiState.Stalk);
                }
                break;
            case AiState.Stalk:
            case AiState.Engage:
                this._thinkAwake(dt);
                break;
            case AiState.Retreat:
                this._thinkRetreat(dt);
                break;
        }
    }

    private _thinkDormant(dt: number, noises: NoiseEvent[]): void {
        this._stareAccum += dt;
        const checkStare = this._stareAccum >= STARE_CHECK_INTERVAL;
        const stareDt = checkStare ? this._stareAccum : 0;
        if (checkStare) this._stareAccum = 0;

        const result = shouldWake(
            this.game,
            this.player,
            this.def,
            noises,
            this._stareTimer,
            stareDt,
            this._humans,
            checkStare,
        );
        if (checkStare) this._stareTimer = result.stareTime;

        if (!result.wake) return;

        this.target = result.target;
        if (result.target) {
            this.lastKnownTargetPos = v2.copy(result.target.pos);
        }
        this._enter(AiState.Rustle);
    }

    private _thinkAwake(dt: number): void {
        this._strafeTimer -= dt;
        if (this._strafeTimer <= 0) {
            this._strafeTimer = this.def.combat.strafeChangeTime;
            this._strafeSign = Math.random() < 0.5 ? 1 : -1;
        }

        // Break off if badly hurt — except the boss, which never runs, and
        // static archetypes, which have nowhere to run to.
        const healthFrac = this.player.health / Math.max(this.player.maxHealth, 1);
        if (
            healthFrac < 0.3
            && this.def.behaviour !== "boss"
            && this.def.behaviour !== "static"
            && this.def.behaviour !== "ambush"
        ) {
            this._enter(AiState.Retreat);
            return;
        }

        const searchRange = Math.max(
            this.def.combat.engageRange,
            this.def.senses.wakeRadius,
        ) * 1.2;
        const visible = findTarget(
            this.game,
            this.player,
            this.def,
            searchRange,
            this._humans,
        );

        if (visible) {
            this.target = visible;
            this.lastKnownTargetPos = v2.copy(visible.pos);
            this._timeSinceSeen = 0;
            this._timeSinceLos = 0;
            this._timeOnTarget += dt;
            if (this.state !== AiState.Engage) this._enter(AiState.Engage);
            return;
        }

        // Still remember a target we can no longer see.
        this._timeOnTarget = 0;
        this._timeSinceLos += dt;

        // Losing sight isn't losing the target. If they're still close they're
        // still being hunted — including through a floor, which is how a player
        // ducking into a basement used to become permanently invisible even
        // when the AI was standing on the stairs.
        const stillClose = this.target
            && !this.target.dead
            && v2.distance(this.target.pos, this.player.pos)
                <= this.def.senses.pursueRange;

        if (!stillClose) this._timeSinceSeen += dt;

        if (this._timeSinceSeen >= this.def.senses.loseTargetTime) {
            this.target = undefined;
            this.lastKnownTargetPos = undefined;
            this._enter(AiState.Dormant);
            return;
        }

        if (this.state !== AiState.Stalk) this._enter(AiState.Stalk);
    }

    private _thinkRetreat(dt: number): void {
        this._timeSinceSeen += dt;
        const healed = this.player.health / Math.max(this.player.maxHealth, 1) > 0.5;

        if (this._stateTimer > 6 || healed) {
            this.target = undefined;
            this._enter(AiState.Dormant);
        }
    }

    private _enter(state: AiState): void {
        this.state = state;
        this._stateTimer = 0;

        switch (state) {
            case AiState.Dormant:
                this._stareTimer = 0;
                this._timeOnTarget = 0;
                this._timeSinceSeen = 0;
                this._pointBlank = false;
                // Freeze the facing so the disguise stops rotating.
                this._aimDir = v2.copy(this.player.dir);
                // Put the gun away. The disguise obstacle is drawn over the
                // player's body, but a rifle is longer than a bush is wide, so
                // a barrel poking out of the foliage gives the whole thing away
                // from across the map. Fists sit inside the sprite.
                this.stowWeapon();
                break;
            case AiState.Rustle:
                // Draw the gun as the telegraph begins, so the weapon appearing
                // is itself part of the tell, and the switch delay is spent
                // inside the rustle window instead of delaying the first shot.
                this._equipGun();
                break;
            case AiState.Engage:
                this._burstRemaining = util.randomInt(
                    this.def.combat.burstMin,
                    this.def.combat.burstMax,
                );
                this._burstPause = 0;
                break;
        }
    }

    /**
     * Decide where to move and where to point. Runs on the think tick only, so
     * the result is held steady for ~10 ticks. That steadiness is the whole
     * point: movement is quantised into four booleans, and recomputing it every
     * tick made disguised enemies visibly shake while they tracked a target.
     */
    private _plan(): void {
        const player = this.player;

        // Nothing else matters if you're standing in the gas. A player would
        // break off and run for the circle, so they do too.
        if (this._planGasFlee()) return;

        // Nor if there's a live grenade at your feet — including your own.
        if (this._planBlastFlee()) return;

        // Getting through a staircase beats every other consideration. Without
        // this an AI that reached the top step would acquire the player below,
        // switch to Engage, and back off to its preferred range — walking right
        // back out of the stairwell it had just found.
        if (this._stairGoal && this.state !== AiState.Dormant) {
            this._planStalk();
            return;
        }

        switch (this.state) {
            case AiState.Dormant:
                this._desiredMove = null;
                this._aimTarget = this._aimDir;
                return;

            case AiState.Rustle:
                // Movement is generated per tick in _act (it's an oscillation),
                // but the facing still swings smoothly onto the target.
                if (this.lastKnownTargetPos) {
                    this._aimTarget = v2.normalizeSafe(
                        v2.sub(this.lastKnownTargetPos, player.pos),
                        this._aimTarget,
                    );
                }
                return;

            case AiState.Stalk:
                this._planStalk();
                return;

            case AiState.Engage:
                this._planEngage();
                return;

            case AiState.Retreat:
                this._planRetreat();
                return;
        }
    }

    /**
     * Pursuit.
     *
     * The original version walked to the last place it saw you and then stopped
     * dead, forever, because `lastKnownTargetPos` never updated while you were
     * out of sight. In dense jungle line of sight breaks constantly, so in
     * practice AI froze mid-chase — measured at 83% of awake ticks with no
     * movement input at all. Two fixes: inside `pursueRange` a mobile AI tracks
     * the target's real position (guerrillas on ground they know, following
     * sound and broken undergrowth), and past that it sweeps rather than stands.
     */
    private _planStalk(): void {
        const player = this.player;

        // Rooted archetypes have nowhere to go; just face the last contact.
        if (this.def.speedMult === 0) {
            if (this.lastKnownTargetPos) {
                this._aimTarget = v2.normalizeSafe(
                    v2.sub(this.lastKnownTargetPos, player.pos),
                    this._aimTarget,
                );
            }
            this._desiredMove = null;
            return;
        }

        const target = this.target;
        if (target && !target.dead) {
            const dist = v2.distance(target.pos, player.pos);
            if (dist <= this.def.senses.pursueRange) {
                this.lastKnownTargetPos = v2.copy(target.pos);
                this._searchGoal = undefined;
            }
        }

        // Different floor: head for the stairs instead of at the ceiling.
        if (this._stairGoal) {
            const toStair = v2.sub(this._stairGoal, player.pos);
            this._aimTarget = v2.normalizeSafe(toStair, this._aimTarget);
            this._desiredMove = this._steer(v2.normalizeSafe(toStair));
            return;
        }

        if (!this.lastKnownTargetPos) {
            this._planSearch();
            return;
        }

        const toGoal = v2.sub(this.lastKnownTargetPos, player.pos);
        const dist = v2.length(toGoal);

        this._aimTarget = v2.normalizeSafe(toGoal, this._aimTarget);
        player.toMouseLen = Math.min(dist, 30);

        // Carrying explosives and about to use them: open up to throwing range
        // instead of hugging whatever is between us.
        //
        // Not when they're already on top of us — at that range the answer is to
        // swing, and backing away politely to grenade distance while being hit
        // meant a hugged AI stopped fighting altogether.
        if (dist > PANIC_RANGE && dist < this._throwStandoff() && this._wantsThrowStandoff()) {
            this._desiredMove = this._steer(v2.neg(v2.normalizeSafe(toGoal)));
            return;
        }

        if (dist < 1.5) {
            // Arrived and they aren't here. Keep looking instead of standing on
            // the spot where they used to be.
            this._planSearch();
            return;
        }

        this._desiredMove = this._steer(v2.normalizeSafe(toGoal));
    }

    /**
     * Keeps an awake AI actually moving: opens doors in the way, notices when it
     * has stopped making progress, and decides whether to shoot through whatever
     * is blocking it or walk around.
     */
    private _updateNavigation(dt: number): void {
        const player = this.player;

        if (this._doorCooldown > 0) this._doorCooldown -= dt;
        if (this._pathCooldown > 0) this._pathCooldown -= dt;
        if (this._sidestepTimer > 0) this._sidestepTimer -= dt;
        if (this._breachTimer > 0) {
            this._breachTimer -= dt;
            if (this._breachTimer <= 0) this._breachTarget = undefined;
        }

        // Doors first: an AI that opens the door never gets stuck on it.
        this._handleDoors();

        const goal = this._currentGoal();

        //
        // Look ahead: if the straight line to the goal is walled off, ask for a
        // route now rather than discovering it by failing for twenty seconds.
        // A player looks at the wall and heads for the door.
        //
        if (goal && this._path.length === 0 && this._desiredMove) {
            if (!this.game.aiBarn.nav.isLineClear(player.pos, goal)) {
                this._requestPath();
            }
        }

        //
        // Progress, not displacement. Sliding along a wall is movement.
        //
        this._progressTimer += dt;
        if (goal && this._progressTimer >= PROGRESS_WINDOW) {
            const dist = v2.distance(player.pos, goal);
            const gained = this._progressRef - dist;
            this._progressTimer = 0;
            this._progressRef = dist;

            if (this._desiredMove && gained < PROGRESS_EPSILON) {
                // Getting nowhere. Steering has had its chance; route properly.
                this._path = [];
                this._requestPath();
            }
        } else if (!goal) {
            this._progressRef = Infinity;
        }

        const moved = v2.distance(this._stuckRef, player.pos);
        this._stuckRef = v2.copy(player.pos);

        // Not trying to move, or moving fine.
        if (!this._desiredMove || moved >= STUCK_EPSILON) {
            this._stuckTimer = 0;
            if (moved >= STUCK_EPSILON) this._stuckStrikes = 0;
            return;
        }

        this._stuckTimer += dt;
        if (this._stuckTimer < STUCK_TIMEOUT) return;
        this._stuckTimer = 0;
        this._tryUnstick();
    }

    /**
     * Use any closed door within reach, exactly as a player pressing the
     * interact key would — same method, same cooldown, same rules.
     */
    private _handleDoors(): void {
        if (this._doorCooldown > 0) return;

        const player = this.player;
        const objs = this.game.grid.intersectCollider(
            collider.createCircle(player.pos, player.rad + INTERACT_RANGE),
        );

        for (let i = 0; i < objs.length; i++) {
            const obj = objs[i];
            if (obj.__type !== ObjectType.Obstacle) continue;
            if (!obj.isDoor || !obj.door || obj.dead) continue;
            if (obj.door.open || obj.door.locked || !obj.door.canUse) continue;
            if (!util.sameLayer(obj.layer, player.layer)) continue;

            // The grid query above is a broad-phase cell overlap, not a real
            // distance check: a wide double door spans several grid cells and
            // comes back as a "hit" from well outside INTERACT_RANGE. This is
            // the actual check — the same circle-vs-collider test a human's
            // own interact key uses — and without it an AI could pop a door
            // open from clear across the room.
            const reach = obj.interactionRad + player.rad;
            if (!collider.intersectCircle(obj.collider, player.pos, reach)) continue;

            obj.interact(player);
            this._doorCooldown = Config.vietnam.doorCooldown;
            return; // one per think, like a player pressing the key once
        }
    }

    /**
     * Something is in the way. Shoot it if it can be shot, otherwise commit to a
     * bearing around it — alternating sides, so a bad first guess doesn't turn
     * into the AI grinding against the same tree forever.
     */
    private _tryUnstick(): void {
        const player = this.player;
        const dir = this._desiredMove;
        if (!dir) return;

        const probe = v2.add(player.pos, v2.mul(dir, player.rad + 2));
        const objs = this.game.grid.intersectCollider(collider.createCircle(probe, 1.5));

        let blocker: Obstacle | undefined;
        for (let i = 0; i < objs.length; i++) {
            const obj = objs[i];
            if (obj.__type !== ObjectType.Obstacle) continue;
            if (obj.dead || !obj.collidable || obj.isSkin) continue;
            if (!util.sameLayer(obj.layer, player.layer)) continue;
            // Prefer the flimsiest thing in the way — that's the cheapest way out.
            if (!blocker || obj.health < blocker.health) blocker = obj;
        }

        if (blocker && blocker.destructible && blocker.health > 0) {
            this._breachTarget = { pos: v2.copy(blocker.pos), id: blocker.__id };
            this._breachTimer = BREACH_TIMEOUT;
            return;
        }

        this._stuckStrikes++;

        // Sidestepping is cheap and usually enough. Twice in a row means this is
        // a concave trap — a tree cluster or a building corner — which repulsion
        // can't reason its way out of, so ask for an actual route.
        if (this._stuckStrikes >= 2) {
            this._stuckStrikes = 0;
            this._requestPath();
            return;
        }

        this._sidestepSign = this._sidestepSign === 0
            ? (Math.random() < 0.5 ? 1 : -1)
            : -this._sidestepSign;
        this._sidestepTimer = SIDESTEP_DURATION;
    }

    /**
     * Run for the safe zone.
     *
     * Rooted archetypes can't, and simply die in the gas like the scenery they
     * are pretending to be. Everything else abandons whatever it was doing —
     * which is exactly what a player does, and it means the late game isn't
     * decided by AI that politely stood still and evaporated.
     */
    private _planGasFlee(): boolean {
        const wasFleeing = this._fleeingGas;
        this._fleeingGas = false;

        const gas = this.game.gas;
        if (gas.mode === GameConfig.GasMode.Inactive) {
            this._gasGoal = undefined;
            return false;
        }

        const toCenter = v2.sub(gas.currentPos, this.player.pos);
        const dist = v2.length(toCenter);

        // Start moving before it hurts, the way a player watching the circle would.
        if (dist < gas.currentRad - Config.vietnam.gasFleeMargin) {
            if (wasFleeing) {
                // Made it. Re-root here so a static archetype goes back to
                // holding ground rather than continuing to roam.
                v2.set(this.homePos, this.player.pos);
                this._gasGoal = undefined;
                this._path = [];
            }
            return false;
        }

        this._fleeingGas = true;

        // Aim for the near edge of the safe zone rather than its centre: it's
        // the same safety for a fraction of the distance, which matters because
        // a long route can exceed the pathfinder's node budget entirely.
        const inward = v2.normalizeSafe(v2.neg(toCenter), v2.create(1, 0));
        this._gasGoal = v2.add(
            gas.currentPos,
            v2.mul(inward, Math.max(0, gas.currentRad * 0.7)),
        );

        const goal = this._gasGoal;
        const dir = v2.normalizeSafe(v2.sub(goal, this.player.pos), v2.normalizeSafe(toCenter));

        // Route around anything in the way — a building or a headland between an
        // AI and the circle used to be a death sentence.
        if (this._path.length === 0 && !this.game.aiBarn.nav.isLineClear(this.player.pos, goal)) {
            this._requestPath();
        }

        this._aimTarget = dir;
        this._desiredMove = this._steer(dir);
        return true;
    }

    /**
     * Get away from any live explosive, whoever threw it.
     *
     * This is second only to the gas, and above chasing, for the same reason a
     * player drops what they are doing when a frag lands next to them: nothing
     * else you were about to do survives the next two seconds otherwise.
     *
     * It applies to the AI's own grenades as much as to the player's, and that
     * is the case that actually bites. A hunter throws a frag fifteen metres
     * ahead of a fleeing player and then sprints after them at twelve metres a
     * second — straight over its own grenade, arriving exactly as the fuse ends.
     * Cooking alone doesn't fix that; not standing on it does.
     *
     * Deliberately not routed through the nav grid: A* costs far more than the
     * two seconds of running away is worth, and "directly away, around the
     * trees" is what a person does here.
     */
    private _planBlastFlee(): boolean {
        const player = this.player;
        this._fleeingBlast = false;
        if (this.state === AiState.Dormant) return false;

        const projectiles = this.game.projectileBarn.projectiles;
        let escape: Vec2 | undefined;
        let worstOverlap = 0;

        for (let i = 0; i < projectiles.length; i++) {
            const proj = projectiles[i];
            if (proj.dead || proj.destroyed) continue;
            if (!util.sameLayer(proj.layer, player.layer)) continue;

            const radius = blastRadiusOf(proj.type);
            if (radius <= 0) continue;

            const away = v2.sub(player.pos, proj.pos);
            const dist = v2.length(away);
            if (dist >= radius) continue;

            // The deepest intrusion wins; ties by distance are meaningless when
            // two blasts have different radii.
            const overlap = radius - dist;
            if (overlap <= worstOverlap) continue;
            worstOverlap = overlap;
            escape = dist > 0.001
                ? v2.div(away, dist)
                // Standing exactly on it: any direction beats staying.
                : v2.copy(this._aimDir);
        }

        if (!escape) return false;

        this._fleeingBlast = true;
        this._path = [];
        // Keep facing whatever we were fighting, so this reads as backing off
        // under fire rather than as a rout — and so the AI can still shoot.
        this._desiredMove = avoidObstacles(this.game, player, escape);
        return true;
    }

    /**
     * Where this AI is currently trying to get to, in priority order. Every
     * movement decision and every path query resolves through here, so a route
     * can never end up aimed at something the AI has already stopped caring
     * about — which is how a stale combat path used to survive into a gas run.
     */
    private _currentGoal(): Vec2 | undefined {
        if (this._fleeingGas && this._gasGoal) return this._gasGoal;
        // A target on another floor is unreachable by walking at it; the goal is
        // the stairwell, and the engine flips the layer once we step on it.
        if (this._stairGoal) return this._stairGoal;
        return this.lastKnownTargetPos ?? this._searchGoal;
    }

    /** Ask the nav grid for a route to wherever we're currently trying to go. */
    private _requestPath(): void {
        if (this._pathCooldown > 0) return;
        // The grid is built from ground-floor geometry only, so a route
        // computed while underground would be nonsense. Steering copes: interiors
        // are small.
        if (this.player.layer !== 0) return;

        const goal = this._currentGoal();
        if (!goal) return;

        const path = this.game.aiBarn.nav.findPath(this.player.pos, goal);

        if (!path || path.length === 0) {
            this._path = [];
            // Retry sooner after a miss than after a hit: a failed lookup means
            // we're still stuck, and waiting the full cooldown is what it feels
            // like to watch an AI stand there doing nothing.
            this._pathCooldown = 0.5;
            return;
        }

        this._path = path;
        this._pathGoal = v2.copy(goal);
        this._pathCooldown = 1.5;
    }

    /**
     * Follow the current route, if there is one. Returns the direction to move,
     * or null when the path is finished or has gone stale.
     */
    private _followPath(): Vec2 | null {
        if (this._path.length === 0) return null;

        const goal = this._currentGoal();
        // The target has moved far enough that the old route is meaningless.
        if (goal && this._pathGoal && v2.distance(goal, this._pathGoal) > 12) {
            this._path = [];
            return null;
        }

        const player = this.player;
        while (this._path.length > 0 && v2.distance(this._path[0], player.pos) < 2.5) {
            this._path.shift();
        }
        if (this._path.length === 0) return null;

        return v2.normalizeSafe(v2.sub(this._path[0], player.pos));
    }

    /**
     * Pick a stairwell when the target is on a different floor.
     *
     * Walking at someone in a basement is walking at the ceiling above them, so
     * the goal becomes the half of a stair that leads the right way. Stepping
     * onto it is all that's needed — the engine's own stair handling changes the
     * layer from there, exactly as it does for a player.
     *
     * Preference is weighted toward stairs near the target rather than near us:
     * the point is to get into *their* building, not the nearest hole.
     */
    private _updateStairGoal(dt: number): void {
        this._stairTimer -= dt;
        if (this._stairTimer > 0) return;
        this._stairTimer = STAIR_SEARCH_INTERVAL;

        const target = this.target;
        const player = this.player;

        if (!target || target.dead || target.layer === player.layer) {
            this._stairGoal = undefined;
            this._stairExit = undefined;
            return;
        }

        // Layers 2 and 3 mean "currently on a staircase". While transiting,
        // keep the staircase we already picked and aim at its far end — the
        // layer only changes when you step off the bottom.
        const onStairs = player.layer === 2 || player.layer === 3;
        if (onStairs && this._stairExit) {
            this._stairGoal = this._stairExit;
            return;
        }

        const goingDown = target.layer > player.layer;
        const structures = this.game.map.structures;

        let best: Vec2 | undefined;
        let bestExit: Vec2 | undefined;
        let bestScore = Infinity;

        const centreOf = (a: { min: Vec2; max: Vec2 }) =>
            v2.add(a.min, v2.mul(v2.sub(a.max, a.min), 0.5));

        for (let i = 0; i < structures.length; i++) {
            const stairs = structures[i].stairs;
            for (let j = 0; j < stairs.length; j++) {
                const stair = stairs[j];
                if (stair.lootOnly) continue;

                // Aim at the mouth of the staircase — the half you step onto
                // from the floor you're on. Going down, that's the top.
                //
                // Aiming at the far end instead made AI curve around the whole
                // stairwell to reach a point beyond it, ending up standing
                // directly above the player having never touched the steps.
                const mouth = centreOf(goingDown ? stair.upAabb : stair.downAabb);
                const exit = v2.add(
                    centreOf(goingDown ? stair.downAabb : stair.upAabb),
                    v2.mul(stair.downDir, goingDown ? 4 : -4),
                );

                const score = v2.distance(mouth, target.pos)
                    + v2.distance(mouth, player.pos) * 0.5;
                if (score < bestScore) {
                    bestScore = score;
                    best = mouth;
                    bestExit = exit;
                }
            }
        }

        // Nothing within reach of the fight isn't worth crossing the map for.
        if (best && v2.distance(best, player.pos) < 90) {
            this._stairGoal = best;
            this._stairExit = bestExit;
        } else {
            this._stairGoal = undefined;
            this._stairExit = undefined;
        }
    }

    /**
     * True when this AI is about to throw and should be holding its distance
     * rather than closing. Only while the throw is imminent — between grenades
     * it goes back to pushing, which is what lets it still come inside.
     */
    /**
     * How far back to hold while a throw is coming up: far enough to be outside
     * the grenade's own blast, and never closer than the flat floor.
     */
    private _throwStandoff(): number {
        const type = this.player.weapons[GameConfig.WeaponSlot.Throwable].type;
        return Math.max(THROW_STANDOFF, type ? minThrowRange(type) : 0);
    }

    private _wantsThrowStandoff(): boolean {
        if (this._throwTimer > THROW_IMMINENT) return false;

        const type = this.player.weapons[GameConfig.WeaponSlot.Throwable].type;
        if (!type) return false;
        if (this.player.invManager.get(type as InventoryItem) <= 0) return false;

        // Only when shooting isn't on the table. Standing off from someone you
        // can plainly see is just refusing to fight: it cost 6m of ground per
        // chase and stopped a hugged AI from swinging back.
        //
        // And only once sight has been lost for a moment. Line of sight breaks
        // constantly while chasing through jungle, and treating every flicker as
        // "they're in cover, back off and grenade" turned pursuit into pacing.
        const target = this.target;
        if (!target || target.dead) return true;
        if (!util.sameLayer(target.layer, this.player.layer)) return true;
        if (this._timeSinceLos < THROW_UNSEEN_TIME) return false;

        return !hasLineOfSight(
            this.game,
            this.player.pos,
            target.pos,
            this.player.layer,
        );
    }

    /** Sweep outward from the last contact rather than standing still. */
    private _planSearch(): void {
        const player = this.player;

        this._searchTimer -= THINK_INTERVAL;

        const needGoal = !this._searchGoal
            || this._searchTimer <= 0
            || v2.distance(this._searchGoal, player.pos) < 2;

        if (needGoal) {
            const base = this.lastKnownTargetPos ?? this.homePos;
            const angle = Math.random() * Math.PI * 2;
            const rad = util.random(7, 18);
            this._searchGoal = v2.add(
                base,
                v2.create(Math.cos(angle) * rad, Math.sin(angle) * rad),
            );
            this._searchTimer = util.random(2, 4);
        }

        const to = v2.sub(this._searchGoal!, player.pos);
        this._aimTarget = v2.normalizeSafe(to, this._aimTarget);
        this._desiredMove = this._steer(v2.normalizeSafe(to));
    }

    /**
     * Obstacle avoidance plus the sidestep the unstick logic may have requested.
     * Everything that produces a movement direction goes through here.
     */
    private _steer(desired: Vec2): Vec2 {
        const onPath = this._followPath();
        if (onPath) {
            // A real route beats feeling around, and it already accounts for
            // the geometry that got us stuck. Local avoidance still runs on top:
            // waypoints are cell centres on a 2-unit grid and a player is about
            // a metre wide, so a legal route can still clip the tree on a corner
            // it cuts. The steer is tangential, so it slides past that tree
            // without ever pushing back along the route.
            return avoidObstacles(this.game, this.player, onPath);
        }

        if (this._sidestepTimer > 0) {
            // Committed to going around something — hold a consistent bearing
            // rather than re-deciding every tick and jittering in place.
            return v2.rotate(desired, (Math.PI / 2) * this._sidestepSign);
        }
        return avoidObstacles(this.game, this.player, desired);
    }

    private _planEngage(): void {
        const player = this.player;
        const target = this.target;

        if (!target || target.dead) {
            this._desiredMove = null;
            return;
        }

        const toTarget = v2.sub(target.pos, player.pos);
        const dist = v2.length(toTarget);

        this._pointBlank = dist < PANIC_RANGE;

        // Aim at the target, offset by an error that is resampled per shot
        // rather than per tick — see aimErrorSpread. At point blank the vector
        // to the target can be near zero, so fall back to the current facing.
        const aim = dist < 0.05
            ? this._aimTarget
            : v2.rotate(v2.normalizeSafe(toTarget), this._aimErrorOffset);
        this._aimTarget = aim;
        player.toMouseLen = Math.min(dist, GameConfig.player.throwableMaxMouseDist);

        if (this._pointBlank) {
            // Back straight out, no strafing — the only goal is to open enough
            // distance that the gun works again. Rooted archetypes get just
            // enough speed to do this and nothing more.
            const away = dist < 0.05
                ? v2.neg(this._aimDir)
                : v2.neg(v2.normalizeSafe(toTarget));
            this._desiredMove = this._steer(away);
            return;
        }

        if (this.def.speedMult === 0) {
            this._desiredMove = null;
            return;
        }

        const desired = dist > this.def.combat.preferredRange * 1.3
            ? v2.normalizeSafe(toTarget)
            : combatMove(toTarget, dist, this.def.combat.preferredRange, this._strafeSign);
        this._desiredMove = this._steer(desired);
    }

    private _planRetreat(): void {
        const player = this.player;

        const away = this.lastKnownTargetPos
            ? v2.sub(player.pos, this.lastKnownTargetPos)
            : v2.sub(this.homePos, player.pos);

        const dir = v2.normalizeSafe(away);
        this._desiredMove = this._steer(dir);
        this._aimTarget = dir;
    }

    /** Resample the aim error cone. Called on each shot and on a slow timer. */
    private _resampleAimError(): void {
        const spread = aimErrorSpread(
            this._timeOnTarget,
            this.def.combat.aimErrorMax,
            this.def.combat.aimErrorMin,
            this.def.combat.aimTightenTime,
        );
        this._aimErrorOffset = util.random(-spread, spread);
        this._aimErrorTimer = AIM_RESAMPLE_INTERVAL;
    }

    /**
     * Writes the input fields the game's own player update consumes. Runs every
     * tick, but only applies the plan made on the last think tick — it makes no
     * fresh decisions of its own beyond easing the facing and metering the
     * trigger. Everything here is the same surface a human client drives, so AI
     * shots obey identical fire rates, spread and reload rules.
     */
    private _act(dt: number): void {
        const player = this.player;

        if (this.state === AiState.Dormant && !this._fleeingGas) {
            player.aiSpeedMult = 1;
            setMoveDir(player, null);
            player.shootHold = false;
            player.dirNew = this._aimDir;
            return;
        }

        if (this._fleeingGas) {
            // Break cover and move — but the legs heading for the circle don't
            // mean the gun stops working. A player breaking for safety with
            // somebody on top of them still fires on the way out; muting the
            // trigger the instant the gas started is what made a tree standing
            // a metre away suddenly ignore you, which reads as broken rather
            // than as "busy running".
            const target = this.target && !this.target.dead ? this.target : undefined;
            const dist = target ? v2.distance(target.pos, player.pos) : Infinity;
            this._pointBlank = dist < PANIC_RANGE;

            const clearShot = !!target
                && dist <= this.def.combat.engageRange
                && !!util.sameLayer(target.layer, player.layer)
                && hasLineOfSight(this.game, player.pos, target.pos, player.layer)
                && !this._ricochetAhead(dist);

            // Aim (independent of the legs) tracks the threat when there is
            // one to shoot; otherwise it just faces the way out.
            if (target && (clearShot || this._pointBlank) && dist > 0.05) {
                this._aimTarget = v2.rotate(
                    v2.normalizeSafe(v2.sub(target.pos, player.pos)),
                    this._aimErrorOffset,
                );
            }
            this._aimDir = rotateToward(this._aimDir, this._aimTarget, TURN_RATE * dt);
            player.dirNew = this._aimDir;

            // Even a rooted archetype uproots for this. Standing still and
            // dissolving is not something anything alive does.
            player.aiSpeedMult = Math.max(this.def.speedMult, 1);
            setMoveDir(player, this._desiredMove);

            // _pointBlank (PANIC_RANGE) also covers the band where bullets
            // can't spawn clear of the shooter, which is wider than an
            // unarmed swing actually reaches. Gate the swing itself on real
            // reach — see FIST_REACH — so a target sitting in that gap gets
            // shot at instead of watched.
            if (dist < FIST_REACH) {
                this._meleeAttack();
                return;
            }
            if (clearShot) {
                player.toMouseLen = Math.min(dist, GameConfig.player.throwableMaxMouseDist);
                this._ensureGunEquipped();
                this._fireControl(dt);
                return;
            }
            player.shootHold = false;
            return;
        }

        //
        // Facing: ease toward the planned direction instead of snapping.
        //
        this._aimDir = rotateToward(this._aimDir, this._aimTarget, TURN_RATE * dt);
        player.dirNew = this._aimDir;

        this._aimErrorTimer -= dt;
        if (this._aimErrorTimer <= 0) this._resampleAimError();

        //
        // Movement
        //
        if (this.state === AiState.Rustle) {
            // The telegraph. A deliberate shiver in place, with the trigger
            // locked out, so an attentive player gets a moment to react before
            // the tree shoots them. This is the one place shaking is the point.
            player.aiSpeedMult = RUSTLE_SPEED_MULT;
            player.shootHold = false;
            const phase = Math.floor(this._stateTimer / RUSTLE_OSCILLATION) % 2 === 0
                ? 1
                : -1;
            setMoveDir(player, v2.mul(v2.perp(this._aimDir), phase));
            return;
        }

        // A live grenade uproots anything, the same way the gas does. Being
        // rooted is a tactical identity, not a reason to stand in a blast.
        player.aiSpeedMult = this._fleeingBlast
            ? Math.max(this.def.speedMult, 1)
            : this._pointBlank
            ? Math.max(this.def.speedMult, ROOTED_ESCAPE_SPEED)
            : this.def.speedMult;

        // Rooted archetypes stay on their leash even while breaking a hug.
        const leashed = this.def.speedMult === 0
            && !this._fleeingGas
            && !this._fleeingBlast
            && v2.distance(this.homePos, player.pos) >= ROOTED_LEASH;

        setMoveDir(player, leashed ? null : this._desiredMove);

        //
        // Breaching: blow through whatever is in the way. This runs while
        // stalking as well as engaging, because the thing blocking a chase is
        // usually not the thing you're chasing.
        //
        if (this._pointBlank) {
            // Somebody standing on top of you outranks any crate in the way.
            this._breachTarget = undefined;
            this._breachTimer = 0;
        }

        if (this._breachTarget) {
            const obj = this.game.objectRegister.getById(this._breachTarget.id);
            const alive = obj && obj.__type === ObjectType.Obstacle && !obj.dead;

            if (!alive) {
                this._breachTarget = undefined;
                this._breachTimer = 0;
            } else {
                this._aimTarget = v2.normalizeSafe(
                    v2.sub(this._breachTarget.pos, player.pos),
                    this._aimTarget,
                );
                this._ensureGunEquipped();
                player.shootHold = true;
                player.shootStart = true;
                return;
            }
        }

        //
        // Grenades.
        //
        // Deliberately available while stalking, not just while engaging.
        // Stalking is precisely the state where the AI knows roughly where
        // somebody is and cannot shoot them — a wall between the two, or a floor.
        // Gating this on Engage meant the flush could never fire in the one
        // situation it exists for: 0 throws in 6 attempts against a player
        // sitting inside a building.
        //
        if (this.state === AiState.Stalk || this.state === AiState.Engage) {
            const aliveTarget = this.target && !this.target.dead ? this.target : undefined;
            const known = aliveTarget?.pos ?? this.lastKnownTargetPos;

            if (known && !this._pointBlank) {
                const knownDist = v2.distance(known, player.pos);
                const shootable = this.state === AiState.Engage
                    && !!aliveTarget
                    && knownDist <= this.def.combat.engageRange
                    && !!util.sameLayer(aliveTarget.layer, player.layer)
                    && hasLineOfSight(this.game, player.pos, aliveTarget.pos, player.layer);

                if (this._tryThrow(dt, knownDist, shootable)) return;
            }
        }

        if (this.state !== AiState.Engage) {
            player.shootHold = false;
            return;
        }

        //
        // Shooting
        //
        const target = this.target;
        if (!target || target.dead) {
            player.shootHold = false;
            return;
        }

        const dist = v2.distance(target.pos, this.player.pos);
        const clearShot = dist <= this.def.combat.engageRange
            && !!util.sameLayer(target.layer, player.layer)
            && hasLineOfSight(this.game, player.pos, target.pos, player.layer)
            && !this._ricochetAhead(dist);

        // Line of sight is irrelevant when they're standing on top of us.
        if (!clearShot && !this._pointBlank) {
            player.shootHold = false;
            return;
        }

        if (this._pointBlank) {
            // Too close to shoot past them — swing instead. Fists reach ~2.25
            // units, which covers the whole range where bullets cannot.
            this._meleeAttack();
            return;
        }

        this._ensureGunEquipped();
        this._fireControl(dt);
    }

    /**
     * Trigger discipline: bursts with pauses, rather than one continuous stream.
     *
     * Burst length is counted from rounds that actually left the gun (by
     * watching the clip) rather than from elapsed time, so it stays correct
     * across every fire mode, reload and fire-delay the weapon defs contain.
     */
    private _fireControl(dt: number): void {
        const player = this.player;
        const combat = this.def.combat;
        const slot = player.curWeapIdx;
        const ammo = player.weapons[slot]?.ammo ?? 0;

        if (slot === this._lastAmmoSlot && this._lastAmmo >= 0 && ammo < this._lastAmmo) {
            this._burstRemaining -= this._lastAmmo - ammo;
            this._resampleAimError();
        }
        this._lastAmmo = ammo;
        this._lastAmmoSlot = slot;

        if (this._burstPause > 0) {
            this._burstPause -= dt;
            player.shootHold = false;
            return;
        }

        if (this._burstRemaining <= 0) {
            this._burstRemaining = util.randomInt(combat.burstMin, combat.burstMax);
            this._burstPause = util.random(combat.burstPauseMin, combat.burstPauseMax);
            player.shootHold = false;
            return;
        }

        // The weapon manager clears shootStart every tick and enforces the gun's
        // own fire delay, so setting both is safe for auto and single alike.
        player.shootHold = true;
        player.shootStart = true;
    }

    /**
     * Would a shot at this range come straight back? Only the near stretch of
     * the firing line is checked, and only when the target is close enough for
     * it to matter — the far wall of a room is somebody else's problem.
     */
    private _ricochetAhead(dist: number): boolean {
        if (dist > RICOCHET_GUARD * 2) return false;

        const reach = Math.min(dist + 1, RICOCHET_GUARD);
        const to = v2.add(this.player.pos, v2.mul(this._aimDir, reach));
        return ricochetRisk(this.game, this.player.pos, to, this.player.layer);
    }

    /** Holster: switch to the melee slot so no gun sprite renders. */
    stowWeapon(): void {
        const player = this.player;
        if (player.curWeapIdx === GameConfig.WeaponSlot.Melee) return;
        player.weaponManager.setCurWeapIndex(GameConfig.WeaponSlot.Melee);
    }

    private _equipGun(): void {
        const player = this.player;
        if (!player.weapons[GameConfig.WeaponSlot.Primary]?.type) return;
        if (player.curWeapIdx === GameConfig.WeaponSlot.Primary) return;
        player.weaponManager.setCurWeapIndex(GameConfig.WeaponSlot.Primary);
    }

    private _meleeAttack(): void {
        const player = this.player;
        if (player.curWeapIdx !== GameConfig.WeaponSlot.Melee) {
            player.weaponManager.setCurWeapIndex(GameConfig.WeaponSlot.Melee);
        }
        player.shootHold = true;
        player.shootStart = true;
    }

    private _ensureGunEquipped(): void {
        const player = this.player;
        if (player.curWeapIdx === GameConfig.WeaponSlot.Primary) return;
        if (!player.weapons[GameConfig.WeaponSlot.Primary].type) return;
        player.weaponManager.setCurWeapIndex(GameConfig.WeaponSlot.Primary);
    }

    /**
     * Decide whether to throw, and do it by driving the same cook-and-release
     * input path a human uses — so fuse timing, arc, bounce and damage are the
     * game's, not ours.
     *
     * The trigger is the interesting part. Throwing is reserved for exactly the
     * case where shooting cannot work: the target is known but *not shootable*,
     * because a wall is in the way or they've gone up or down a floor. That is
     * the classic flush — you don't beat the position, you make it untenable —
     * and it's what stops a house or a basement from being a solved problem for
     * a player who simply steps out of line of sight.
     *
     * Returns true while a throw is in progress.
     */
    private _tryThrow(dt: number, dist: number, hasClearShot: boolean): boolean {
        const player = this.player;
        const slot = GameConfig.WeaponSlot.Throwable;

        // Mid-throw: hold the cook until the cook timer says release. This is a
        // separate clock from the cooldown between grenades — conflating the two
        // is what made the AI cook every frag until it went off in its hands.
        if (player.weaponManager.cookingThrowable) {
            this._cookTimer -= dt;
            player.shootHold = this._cookTimer > 0;
            return true;
        }

        this._throwTimer -= dt;
        if (this._throwTimer > 0) return false;
        // Pulling a pin while scrambling out of somebody else's blast is how you
        // end up holding two problems.
        if (this._fleeingBlast) return false;

        const throwable = player.weapons[slot].type;
        if (!throwable) return false;
        if (player.invManager.get(throwable as InventoryItem) <= 0) return false;

        // A clean shot is always better than a grenade.
        if (hasClearShot) return false;

        // And a moment without one is not cover. Line of sight breaks every few
        // strides in jungle this dense, so throwing on the first flicker meant
        // grenades during open chases: the AI stopped to cook, backed out of its
        // own blast, and gave up 25m of ground for a grenade it could have
        // replaced with a burst a second later. Measured, that alone was most of
        // the difference between a hunter that stays on you and one that doesn't.
        //
        // A floor is the exception, and it's the case the mechanic exists for.
        // Somebody who has dropped into a basement isn't briefly behind a tree —
        // no amount of waiting or walking will produce a shot from up here, and
        // a grenade down the stairwell is the answer a person reaches for.
        const target = this.target;
        const sameFloor = !target || target.dead
            || !!util.sameLayer(target.layer, player.layer);
        if (sameFloor && this._timeSinceLos < THROW_UNSEEN_TIME) return false;
        if (dist < minThrowRange(throwable) || dist > THROW_MAX_RANGE) return false;

        const aimAt = target && !target.dead ? target.pos : this.lastKnownTargetPos;
        if (!aimAt) return false;

        this._throwTimer = util.random(
            Config.vietnam.throwCooldown,
            Config.vietnam.throwCooldown * 1.8,
        );
        this._cookTimer = cookTimeFor(throwable);

        // Throw strength is derived from toMouseLen, so this is what sets range.
        this._aimTarget = v2.normalizeSafe(v2.sub(aimAt, player.pos), this._aimTarget);
        player.toMouseLen = Math.min(dist, GameConfig.player.throwableMaxMouseDist);

        player.weaponManager.setCurWeapIndex(slot);
        player.shootStart = true;
        player.shootHold = true;
        return true;
    }

    /** Called by Player.damage so being shot at wakes an AI instantly. */
    onDamaged(source?: Player): void {
        if (this.player.dead) return;

        if (source && !source.isAI) {
            this.target = source;
            this.lastKnownTargetPos = v2.copy(source.pos);
            this._timeSinceSeen = 0;
            this._timeSinceLos = 0;
        }

        if (this.state === AiState.Dormant) {
            // Being shot skips most of the telegraph — the player already knows
            // where it is, so a full rustle would just be a free hit for them.
            this._enter(AiState.Rustle);
            this._stateTimer = this.def.combat.reactionDelay * 0.5;
        }
    }
}
