/**
 * Definitions for the AI "jungle" faction used by Vietnam mode.
 *
 * These are NOT registered in `GameObjectDefs` — they are not game objects.
 * An AI entity is an ordinary {@link Player} wearing a costume outfit (an outfit
 * with an `obstacleType`, see outfitDefs.ts) so the client renders it as a real
 * piece of scenery. Everything below is tuning data for the server-side
 * controller in `server/src/game/ai/`.
 *
 * Display names are deliberately plain English: they appear in the killfeed,
 * which is rendered with a bitmap font that has no Vietnamese diacritics.
 *
 * The design intent: a DORMANT enemy is byte-for-byte identical to a real
 * obstacle of the same type. The only information the player ever gets is the
 * "rustle" telegraph (`combat.reactionDelay`) between waking and firing, so
 * that value is the single most important fairness knob in the mode.
 */

/** Degrees to radians, purely so the tables below stay readable. */
const deg = (d: number): number => (d * Math.PI) / 180;

export type AiBehaviour =
    /** Sits still until something walks close, then commits hard. */
    | "ambush"
    /** Never moves at all. Zones open ground from concealment. */
    | "static"
    /** Actively seeks the nearest player and tries to close. */
    | "hunter"
    /** Keeps its distance and lobs throwables to push players out of cover. */
    | "harass"
    /**
     * Holds a long-range preferred distance and repositions to keep it, but
     * doesn't give chase once a target is out of sight — the mobility of a
     * hunter without the instinct to close. A sniper standing dead still with
     * a rifle is a turret, not an ambusher; this is what lets it back off a
     * flanker, relocate for a lane, or break off when hurt like anything else
     * that can move, while still never running you down across the map.
     */
    | "kiter"
    /** One per match, announced, high health. */
    | "boss";

export interface AiSenses {
    /** A living player inside this radius (metres) wakes a dormant AI. */
    wakeRadius: number;
    /** A gunshot or explosion inside this radius wakes a dormant AI. */
    hearRadius: number;
    /**
     * A player holding line of sight on a dormant AI for this long wakes it.
     * Stops players from safely staring down a suspicious tree forever.
     */
    stareTimeout: number;
    /** Seconds without line of sight before the AI gives up and re-hides. */
    loseTargetTime: number;
    /**
     * How far a mobile AI will keep pursuing a target it has lost sight of.
     * Inside this range it tracks the target's real position — these are
     * guerrillas on ground they know, following sound and broken undergrowth.
     * Beyond it they fall back to searching the last place they saw them.
     */
    pursueRange: number;
    /** Field of view once awake, in degrees. Dormant AI are omnidirectional. */
    fovDeg: number;
}

export interface AiCombat {
    /** Will not open fire beyond this range (metres). */
    engageRange: number;
    /** Tries to hold roughly this distance from its target. */
    preferredRange: number;
    /** Aim cone the instant a target is acquired (radians). */
    aimErrorMax: number;
    /** Aim cone after `aimTightenTime` of continuous tracking (radians). */
    aimErrorMin: number;
    /** Seconds of continuous tracking to go from aimErrorMax to aimErrorMin. */
    aimTightenTime: number;
    burstMin: number;
    burstMax: number;
    burstPauseMin: number;
    burstPauseMax: number;
    /**
     * THE RUSTLE. Seconds between waking and being allowed to fire.
     * The player's entire counterplay budget lives in this number.
     */
    reactionDelay: number;
    /** How often (seconds) the AI picks a new strafe direction while engaging. */
    strafeChangeTime: number;
}

export interface AiArchetypeDef {
    /** Name shown in the killfeed. */
    displayName: string;
    /** Overrides `Player.maxHealth` for this entity. */
    health: number;
    /** Multiplier applied to the final computed move speed. 0 = rooted. */
    speedMult: number;
    behaviour: AiBehaviour;
    /** Weighted pool; one is chosen at spawn. Clip size comes from the gun def. */
    weapons: Array<{ type: string; weight: number }>;
    senses: AiSenses;
    combat: AiCombat;
    /**
     * Bonus loot dropped on death, on top of the AI's own gun and ammo.
     * `odds` of 1 means guaranteed. Tier names resolve through the map's lootTable.
     */
    loot: Array<{ tier: string; count: number; odds: number }>;
    /** Broadcast a role-style announcement when this one spawns. */
    announce?: boolean;
    /** Projectile type detonated on death (the Sapper). */
    explodeOnDeath?: { type: string; count: number; rad: number };
}

/**
 * Per-map AI configuration, set on `MapDef.gameMode.ai`.
 */
export interface AiModeConfig {
    /** Whether this map has a jungle at all. The master switch is Config.vietnam.enabled. */
    enabled: boolean;
    archetypeWeights: Record<string, number>;
    /**
     * Costume outfits AI can wear, weighted. Any archetype can wear any of
     * these — appearance is deliberately decoupled from behaviour so the shape
     * of a thing tells you nothing about what it's carrying or how it fights.
     *
     * Only living cover belongs here. A rock that gets up and walks reads as a
     * bug rather than as an ambush, so the pool is trees, bushes and stumps.
     */
    disguisePool: Record<string, number>;
    /**
     * Throwables AI can carry, weighted. Every AI gets exactly one type.
     *
     * This is the answer to a player who holes up indoors: a grenade doesn't
     * need line of sight, so cover that defeats rifles doesn't defeat this.
     * Real militaries call it flushing, and shooter AI has used it since the
     * original Counter-Strike bots — you don't beat the position, you make the
     * position untenable.
     */
    throwablePool: Record<string, number>;
    director: {
        /** Intensity above which the director stops spawning near a player. */
        peakThreshold: number;
        relaxDurationMin: number;
        relaxDurationMax: number;
        /** Intensity points shed per second while out of contact. */
        intensityDecay: number;
        /** Never spawn closer than this to any human (metres). */
        minSpawnDist: number;
        /** Never spawn further than this from the nearest human. */
        maxSpawnDist: number;
        /** Cull AI further than this from every human. */
        despawnDist: number;
    };
    /** Spawn density multiplier as the gas closes in. */
    escalation: Array<{ circleIdx: number; densityMult: number }>;
    boss?: { archetype: string; circleIdx: number };
}

export const AiDefs = {
    /**
     * Creeper — the backbone of the faction. Cheap, fragile, and terrifying
     * at three metres. Most of what a player kills will be one of these.
     */
    creeper: {
        displayName: "Creeper",
        health: 60,
        speedMult: 1.15,
        behaviour: "ambush",
        weapons: [
            { type: "m870", weight: 3 },
            { type: "mp5", weight: 2 },
            { type: "ot38", weight: 1 },
        ],
        senses: {
            wakeRadius: 10,
            hearRadius: 30,
            stareTimeout: 3.5,
            loseTargetTime: 8,
            pursueRange: 26,
            fovDeg: 200,
        },
        combat: {
            engageRange: 12,
            preferredRange: 5,
            aimErrorMax: deg(14),
            aimErrorMin: deg(5),
            aimTightenTime: 1,
            burstMin: 1,
            burstMax: 3,
            burstPauseMin: 0.35,
            burstPauseMax: 0.9,
            reactionDelay: 0.35,
            strafeChangeTime: 0.8,
        },
        loot: [
            { tier: "tier_ammo", count: 1, odds: 1 },
            { tier: "tier_medical", count: 1, odds: 0.4 },
        ],
    },

    /**
     * Sniper Tree — rooted. Punishes open ground and forces players to use
     * the canopy. Its long reload is the counterplay; close the distance.
     */
    sniper_tree: {
        displayName: "Sniper Tree",
        health: 100,
        // Not rooted. A sniper that can't reposition is a free kill for anyone
        // who finds an angle on it; slower than the archetypes built to chase,
        // because the thing that should keep you at range is the rifle, not
        // its legs.
        speedMult: 0.9,
        behaviour: "kiter",
        weapons: [
            { type: "mosin", weight: 3 },
            { type: "svd", weight: 1 },
        ],
        senses: {
            wakeRadius: 45,
            hearRadius: 60,
            stareTimeout: 5,
            loseTargetTime: 5,
            // Enough to reposition for a shot on somebody who ducked behind
            // the nearest tree, not enough to hunt you across the map — that's
            // still what makes it a sniper and not a second stump_runner.
            pursueRange: 20,
            fovDeg: 360,
        },
        combat: {
            engageRange: 60,
            preferredRange: 45,
            aimErrorMax: deg(9),
            aimErrorMin: deg(1.5),
            aimTightenTime: 1.8,
            burstMin: 1,
            burstMax: 1,
            burstPauseMin: 1.4,
            burstPauseMax: 2.6,
            reactionDelay: 0.5,
            strafeChangeTime: 999,
        },
        loot: [
            { tier: "tier_ammo", count: 1, odds: 1 },
            { tier: "tier_scopes", count: 1, odds: 0.35 },
        ],
    },

    /**
     * Stump Runner — the pressure element. Fast, actively hunts, and will not let a
     * player sit still. Deliberately approaches off-axis rather than beelining.
     */
    stump_runner: {
        displayName: "Stump Runner",
        health: 80,
        speedMult: 1.3,
        behaviour: "hunter",
        weapons: [
            { type: "mp5", weight: 3 },
            { type: "ak47", weight: 2 },
            { type: "famas", weight: 1 },
        ],
        senses: {
            wakeRadius: 18,
            hearRadius: 40,
            stareTimeout: 4,
            loseTargetTime: 14,
            pursueRange: 70,
            fovDeg: 240,
        },
        combat: {
            engageRange: 30,
            preferredRange: 14,
            aimErrorMax: deg(12),
            aimErrorMin: deg(4),
            aimTightenTime: 1.2,
            burstMin: 3,
            burstMax: 6,
            burstPauseMin: 0.4,
            burstPauseMax: 1,
            reactionDelay: 0.4,
            strafeChangeTime: 0.7,
        },
        loot: [
            { tier: "tier_ammo", count: 1, odds: 1 },
            { tier: "tier_medical", count: 1, odds: 0.4 },
            { tier: "tier_armor", count: 1, odds: 0.15 },
        ],
    },

    /**
     * Leaf Sapper — does not want to kill you, wants to move you. Lobs frags from
     * range and detonates on death, so killing it at point blank is a mistake.
     */
    sapper: {
        displayName: "Leaf Sapper",
        health: 45,
        speedMult: 1,
        behaviour: "harass",
        weapons: [{ type: "ot38", weight: 1 }],
        senses: {
            wakeRadius: 14,
            hearRadius: 30,
            stareTimeout: 4,
            loseTargetTime: 10,
            pursueRange: 40,
            fovDeg: 220,
        },
        combat: {
            engageRange: 22,
            preferredRange: 18,
            aimErrorMax: deg(16),
            aimErrorMin: deg(7),
            aimTightenTime: 1,
            burstMin: 1,
            burstMax: 2,
            burstPauseMin: 1.6,
            burstPauseMax: 3,
            reactionDelay: 0.45,
            strafeChangeTime: 0.6,
        },
        loot: [
            { tier: "tier_throwables", count: 1, odds: 1 },
            { tier: "tier_medical", count: 1, odds: 0.3 },
        ],
        explodeOnDeath: { type: "martyr_nade", count: 3, rad: 4 },
    },

    /**
     * Old Banyan — one per match, announced when it spawns. Slow, enormously tough,
     * and carries a machine gun. Meant to be fought as an event, not ambushed into.
     */
    banyan: {
        displayName: "Old Banyan",
        health: 350,
        speedMult: 0.8,
        behaviour: "boss",
        weapons: [
            { type: "pkp", weight: 1 },
            { type: "m249", weight: 1 },
        ],
        senses: {
            wakeRadius: 30,
            hearRadius: 70,
            stareTimeout: 6,
            loseTargetTime: 20,
            pursueRange: 90,
            fovDeg: 360,
        },
        combat: {
            engageRange: 45,
            preferredRange: 22,
            aimErrorMax: deg(10),
            aimErrorMin: deg(3),
            aimTightenTime: 1.5,
            burstMin: 8,
            burstMax: 16,
            burstPauseMin: 0.8,
            burstPauseMax: 1.6,
            reactionDelay: 0.6,
            strafeChangeTime: 1.2,
        },
        loot: [
            { tier: "tier_chest", count: 1, odds: 1 },
            { tier: "tier_medical", count: 2, odds: 1 },
            { tier: "tier_airdrop_rare", count: 1, odds: 0.5 },
        ],
        announce: true,
    },
} satisfies Record<string, AiArchetypeDef>;

export type AiArchetype = keyof typeof AiDefs;

export function getAiDef(type: AiArchetype): AiArchetypeDef {
    return AiDefs[type];
}

export function isAiArchetype(type: string): type is AiArchetype {
    return type in AiDefs;
}
