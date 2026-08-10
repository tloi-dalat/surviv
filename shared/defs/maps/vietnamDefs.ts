import { GameConfig } from "../../gameConfig.ts";
import { util } from "../../utils/util.ts";
import type { MapDef } from "../mapDefs.ts";
import { Main, type PartialMapDef } from "./baseDefs.ts";

/**
 * Vietnam — a battle royale where the terrain is hostile.
 *
 * Mechanically this is Woods with the density turned up and an AI faction
 * seeded through it. The AI wear costume outfits (see aiDefs.ts) so they render
 * as the exact same tree and bush sprites the map generator scatters around,
 * which is why the foliage counts below matter as much as the AI tuning does:
 * a fake bush is only frightening when there are 500 real ones to hide among.
 *
 * Atlas note: every sprite the AI archetypes disguise as is already covered by
 * the same atlas set Woods uses — map-bush-01 lives in `gradient`, map-tree-09
 * in `shared`, and map-tree-05 / map-tree-07 / map-bush-06 in `woods`. No new
 * atlas, and no new art, is required.
 */
const mapDef: PartialMapDef = {
    mapId: GameConfig.MapId.Vietnam,
    desc: {
        name: "Vietnam",
        icon: "img/gui/player-king-woods.svg",
        buttonCss: "btn-mode-vietnam",
    },
    assets: {
        audio: [
            { name: "vault_change_02", channel: "sfx" },
            { name: "footstep_08", channel: "sfx" },
            { name: "footstep_09", channel: "sfx" },
            { name: "bush_enter_01", channel: "sfx" },
            { name: "helmet03_forest_pickup_01", channel: "ui" },
        ],
        atlases: ["gradient", "loadout", "shared", "woods"],
    },
    biome: {
        colors: {
            background: 0x163a2a,
            water: 0x3a6b52,
            waterRipple: 0x9fe0c0,
            beach: 0xa89050,
            riverbank: 0x4a3a14,
            grass: 0x2f4f21,
            underground: 0x120c04,
            playerSubmerge: 0x2f6b52,
            // must track `grass` closely or ghillie players stand out,
            // which would undercut the whole point of the mode
            playerGhillie: 0x2f4f21,
        },
        valueAdjust: 0.85,
        particles: { camera: "falling_leaf" },
    },
    gameMode: {
        maxPlayers: 80,
        killLeaderEnabled: true,
        woodsMode: true,
        vietnamMode: true,
        ai: {
            enabled: true,
            archetypeWeights: {
                creeper: 45,
                stump_runner: 25,
                sniper_tree: 20,
                sapper: 10,
            },
            // Any shape can be any role. A bush might be the sniper and a tree
            // might be the one that charges you, so the silhouette tells you
            // nothing — which is the whole point of the mode. Weights roughly
            // track how common the real obstacle is on the map, so the fakes
            // are distributed like the scenery they hide in.
            disguisePool: {
                outfitBush: 30, // bush_01  — ~530 real ones
                outfitHalloweenTree: 30, // tree_07  — ~1,200 real ones
                outfitStump: 14, // tree_09  — ~170 real ones
                outfitLeafPile: 14, // bush_06  — ~235 real ones
                outfitTreeSpooky: 8, // tree_05  — ~60 real ones
            },
            // Frags and MIRVs do the flushing; smoke and strobe are there so
            // not every exchange plays out the same way.
            throwablePool: {
                frag: 45,
                mirv: 18,
                smoke: 22,
                strobe: 15,
            },
            director: {
                peakThreshold: 85,
                relaxDurationMin: 25,
                relaxDurationMax: 40,
                intensityDecay: 8,
                minSpawnDist: 45,
                maxSpawnDist: 110,
                despawnDist: 150,
            },
            escalation: [
                { circleIdx: 0, densityMult: 1 },
                { circleIdx: 2, densityMult: 1.4 },
                { circleIdx: 4, densityMult: 1.8 },
                { circleIdx: 6, densityMult: 2.2 },
            ],
            boss: { archetype: "banyan", circleIdx: 4 },
        },
    },
    gameConfig: {
        /* STRIP_FROM_PROD_CLIENT:START */
        planes: {
            timings: [
                {
                    circleIdx: 1,
                    wait: 10,
                    options: { type: GameConfig.Plane.Airdrop },
                },
                // "Rolling Thunder" — area denial that pushes players out of the
                // canopy they've been using as cover, and into open ground where
                // the rooted snipers are waiting.
                {
                    circleIdx: 3,
                    wait: 20,
                    options: {
                        type: GameConfig.Plane.Airstrike,
                        numPlanes: [
                            { count: 2, weight: 5 },
                            { count: 3, weight: 2 },
                            { count: 4, weight: 0.25 },
                        ],
                        airstrikeZoneRad: 55,
                        wait: 1.5,
                        delay: 1,
                    },
                },
                {
                    circleIdx: 4,
                    wait: 4,
                    options: { type: GameConfig.Plane.Airdrop },
                },
            ],
            crates: [
                { name: "airdrop_crate_01", weight: 10 },
                { name: "airdrop_crate_02", weight: 1 },
            ],
        },
        /* STRIP_FROM_PROD_CLIENT:END */
        bagSizes: {
            frag: [6, 12, 15, 18],
            smoke: [6, 12, 15, 18],
        },
    },
    /* STRIP_FROM_PROD_CLIENT:START */
    lootTable: {
        // Ghillie is the player's answer to the mode's central problem, so it is
        // dramatically more common here than the 0.01 it sits at on other maps.
        tier_outfits: [
            { name: "outfitGhillie", count: 1, weight: 0.15 },
            { name: "outfitWoodland", count: 1, weight: 0.3 },
            { name: "outfitCamo", count: 1, weight: 0.25 },
            { name: "outfitKeyLime", count: 1, weight: 0.1 },
            // Costume outfits, so a player can play the jungle's own trick back
            // on everyone else. Rare enough to stay a story rather than a tactic.
            { name: "outfitBush", count: 1, weight: 0.05 },
            { name: "outfitStump", count: 1, weight: 0.04 },
            { name: "outfitHalloweenTree", count: 1, weight: 0.03 },
        ],
        tier_guns: [
            { name: "dp28", count: 1, weight: 2.5 },
            { name: "bar", count: 1, weight: 2.5 },
            { name: "ak47", count: 1, weight: 3 },
            { name: "famas", count: 1, weight: 2 },
            { name: "m870", count: 1, weight: 2.5 },
            { name: "m1100", count: 1, weight: 3 },
            { name: "mp5", count: 1, weight: 2.5 },
            { name: "mp220", count: 1, weight: 1.5 },
            { name: "spas12", count: 1, weight: 2 },
            { name: "mosin", count: 1, weight: 1.25 },
            { name: "svd", count: 1, weight: 0.35 },
            { name: "saiga", count: 1, weight: 0.15 },
            { name: "qbb97", count: 1, weight: 0.125 },
            { name: "pkp", count: 1, weight: 0.007 },
            { name: "m249", count: 1, weight: 0.011 },
        ],
        tier_ammo: [
            { name: "762mm", count: 60, weight: 4 },
            { name: "556mm", count: 60, weight: 5 },
            { name: "9mm", count: 60, weight: 3 },
            { name: "12gauge", count: 10, weight: 2 },
        ],
        tier_ammo_crate: [
            { name: "762mm", count: 60, weight: 4 },
            { name: "556mm", count: 60, weight: 5 },
            { name: "9mm", count: 60, weight: 3 },
            { name: "12gauge", count: 10, weight: 2 },
        ],
        tier_throwables: [
            { name: "frag", count: 3, weight: 1 },
            { name: "mirv", count: 2, weight: 0.4 },
            { name: "smoke", count: 1, weight: 1.5 },
            { name: "strobe", count: 1, weight: 0.2 },
        ],
    },
    mapGen: {
        map: {
            scale: { small: 1.1875, large: 1.21875 },
            shoreInset: 8,
            grassInset: 12,
            rivers: {
                // wide, shallow, braided water — rice paddies and the delta
                lakes: [],
                weights: [
                    { weight: 0.1, widths: [4] },
                    { weight: 0.2, widths: [8, 4] },
                    { weight: 0.3, widths: [8, 8, 4] },
                    { weight: 0.25, widths: [8, 8] },
                    { weight: 0.15, widths: [8, 8, 6, 4] },
                ],
                smoothness: 0.4,
                masks: [],
            },
        },
        customSpawnRules: {
            locationSpawns: [],
            placeSpawns: [],
        },
        // Foliage lives here rather than in fixedSpawns on purpose. densitySpawns
        // counts are multiplied by the map's actual shore area, so they stay at a
        // constant density whatever size the map ends up: solo, squad, or a duel
        // running at a reduced map scale. fixedSpawns counts are absolute, which
        // is why a shrunken duel map full of fixed trees becomes a solid wall.
        //
        // Every obstacle an AI archetype disguises as must appear here in
        // quantity, or the disguise has nothing to hide among:
        //   bush_01  <- Creeper (bush_01b)
        //   bush_06  <- Leaf Sapper (bush_06b)
        //   tree_07  <- Sniper Tree
        //   tree_09  <- Stump Runner
        //   tree_05  <- Old Banyan
        densitySpawns: [
            {
                stone_01: 40,
                barrel_01: 30,
                crate_01: 48,
                crate_03: 10,
                // Bush counts are the mode's difficulty dial as much as any AI
                // stat is. Fewer bushes means every bush is suspicious, which
                // makes the disguise worthless. Bushes don't block movement, so
                // these can be generous where the tree counts can't.
                bush_01: 300,
                bush_06: 110,
                tree_07: 680,
                tree_08: 400,
                tree_08b: 58,
                tree_09: 95,
                tree_05: 39,
                hedgehog_01: 8,
                container_01: 2,
                container_02: 2,
                shack_01: 4,
                outhouse_01: 4,
                loot_tier_1: 40,
                loot_tier_beach: 6,
            },
        ],
        fixedSpawns: [
            {
                logging_complex_02: 1,
                logging_complex_03: 2,
                warehouse_01: 2,
                house_red_01: 2,
                barn_01: 2,
                cache_03: 40,
                cache_01w: 1,
                cache_02w: 1,
                // bunkers double as the AI's preferred spawn anchors —
                // enemies emerging from tunnel mouths rather than popping in
                bunker_structure_01b: 2,
                bunker_structure_03: 2,
                bunker_structure_07: 1,
                chest_03: { odds: 0.5 },
                crate_19: 10,
                stone_04: 4,
                // landmark trees only — the canopy itself is a densitySpawn
                tree_02: 6,
            },
        ],
        randomSpawns: [],
        spawnReplacements: [
            {
                tree_01: "tree_07",
                crate_02: "crate_19",
                crate_08: "crate_19",
                crate_09: "crate_19",
                recorder_01: "recorder_08",
                recorder_02: "recorder_09",
            },
        ],
    },
    /* STRIP_FROM_PROD_CLIENT:END */
};

export const Vietnam = util.mergeDeep({}, Main, mapDef) as MapDef;
