import { ObjectType } from "../../../../shared/net/objectSerializeFns.ts";
import { collider } from "../../../../shared/utils/collider.ts";
import { v2, type Vec2 } from "../../../../shared/utils/v2.ts";
import type { Game } from "../game.ts";

/**
 * Coarse navigation grid and A* for Vietnam-mode AI.
 *
 * Steering alone is enough in open jungle and much cheaper, so it stays the
 * primary means of movement — this is the fallback for when it isn't working.
 * Measured before it existed: an AI only reached a stationary player about
 * two-thirds of the time, because a cluster of trees or a building wall is a
 * concave trap that repulsion cannot get out of. That's the "it couldn't find
 * a way to me even though I was close" case.
 *
 * Cells are 2 units, so a full-size map is roughly 360x360 — one byte each,
 * built once per match and shared by every AI.
 */
const CELL_SIZE = 2;

/** Hard ceiling on nodes expanded per query, so one call can't stall a tick. */
const NODE_BUDGET = 1800;

/** Obstacles shorter than this don't stop a player, so they don't block a path. */
const BLOCK_HEIGHT = 0.5;

export class NavGrid {
    readonly game: Game;
    readonly cols: number;
    readonly rows: number;
    /** 1 = impassable. */
    private readonly _blocked: Uint8Array;

    // Scratch buffers, reused across queries so pathfinding allocates nothing.
    private readonly _cameFrom: Int32Array;
    private readonly _gScore: Float32Array;
    private readonly _visitedTag: Int32Array;
    private _queryId = 0;

    constructor(game: Game) {
        this.game = game;
        this.cols = Math.ceil(game.map.width / CELL_SIZE) + 1;
        this.rows = Math.ceil(game.map.height / CELL_SIZE) + 1;

        const size = this.cols * this.rows;
        this._blocked = new Uint8Array(size);
        this._cameFrom = new Int32Array(size);
        this._gScore = new Float32Array(size);
        this._visitedTag = new Int32Array(size);

        this._build();
    }

    private _idx(cx: number, cy: number): number {
        return cy * this.cols + cx;
    }

    private _cellOf(pos: Vec2): { cx: number; cy: number } {
        return {
            cx: Math.max(0, Math.min(this.cols - 1, Math.floor(pos.x / CELL_SIZE))),
            cy: Math.max(0, Math.min(this.rows - 1, Math.floor(pos.y / CELL_SIZE))),
        };
    }

    private _centre(cx: number, cy: number): Vec2 {
        return v2.create((cx + 0.5) * CELL_SIZE, (cy + 0.5) * CELL_SIZE);
    }

    /**
     * Mark every cell covered by something a player can't walk through.
     *
     * Doors are deliberately left passable: AI open them, so treating a closed
     * door as a wall would route them the long way round their own front door.
     */
    private _build(): void {
        const obstacles = this.game.map.obstacles;

        for (let i = 0; i < obstacles.length; i++) {
            const o = obstacles[i];
            if (o.dead || o.isSkin || !o.collidable) continue;
            if (o.height < BLOCK_HEIGHT) continue;
            if (o.isDoor) continue;
            if (o.layer !== 0) continue;

            const aabb = collider.toAabb(o.collider);
            const minX = Math.max(0, Math.floor(aabb.min.x / CELL_SIZE));
            const maxX = Math.min(this.cols - 1, Math.floor(aabb.max.x / CELL_SIZE));
            const minY = Math.max(0, Math.floor(aabb.min.y / CELL_SIZE));
            const maxY = Math.min(this.rows - 1, Math.floor(aabb.max.y / CELL_SIZE));

            for (let cx = minX; cx <= maxX; cx++) {
                for (let cy = minY; cy <= maxY; cy++) {
                    this._blocked[this._idx(cx, cy)] = 1;
                }
            }
        }
    }

    /**
     * True if a straight walk from `from` to `to` crosses nothing solid.
     *
     * This is what lets an AI notice it needs a route *before* it wastes twenty
     * seconds sliding along the outside of a building. Walking cells is far
     * cheaper than an A* query, so it can run on every think tick.
     */
    isLineClear(from: Vec2, to: Vec2): boolean {
        const dist = v2.distance(from, to);
        const steps = Math.ceil(dist / (CELL_SIZE * 0.5));
        if (steps <= 1) return true;

        for (let i = 1; i < steps; i++) {
            const t = i / steps;
            const px = from.x + (to.x - from.x) * t;
            const py = from.y + (to.y - from.y) * t;
            const cx = Math.max(0, Math.min(this.cols - 1, Math.floor(px / CELL_SIZE)));
            const cy = Math.max(0, Math.min(this.rows - 1, Math.floor(py / CELL_SIZE)));
            if (this._blocked[this._idx(cx, cy)] === 1) return false;
        }

        return true;
    }

    isBlocked(pos: Vec2): boolean {
        const { cx, cy } = this._cellOf(pos);
        return this._blocked[this._idx(cx, cy)] === 1;
    }

    /**
     * A* from `from` to `to`, returning waypoints in world space, or null if no
     * route was found inside the node budget.
     *
     * The start cell is treated as passable even when blocked — an AI wedged
     * inside an obstacle still needs a way out.
     */
    findPath(from: Vec2, to: Vec2): Vec2[] | null {
        const start = this._cellOf(from);
        const goal = this._cellOf(to);

        const startIdx = this._idx(start.cx, start.cy);
        let goalIdx = this._idx(goal.cx, goal.cy);

        if (startIdx === goalIdx) return [];

        // If the goal itself is inside something solid, aim for the nearest
        // open cell around it rather than failing outright.
        if (this._blocked[goalIdx] === 1) {
            const relaxed = this._nearestOpen(goal.cx, goal.cy);
            if (relaxed === -1) return null;
            goalIdx = relaxed;
        }

        const tag = ++this._queryId;
        const open: number[] = [startIdx];
        const openF: number[] = [0];

        this._visitedTag[startIdx] = tag;
        this._gScore[startIdx] = 0;
        this._cameFrom[startIdx] = -1;

        let expanded = 0;

        while (open.length > 0) {
            // Linear scan for the cheapest node. The frontier stays small at
            // these distances, and it keeps the whole thing allocation-free.
            let bestAt = 0;
            for (let i = 1; i < open.length; i++) {
                if (openF[i] < openF[bestAt]) bestAt = i;
            }

            const current = open[bestAt];
            open.splice(bestAt, 1);
            openF.splice(bestAt, 1);

            if (current === goalIdx) return this._reconstruct(current);
            if (++expanded > NODE_BUDGET) return null;

            const cx = current % this.cols;
            const cy = (current - cx) / this.cols;

            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    if (dx === 0 && dy === 0) continue;

                    const nx = cx + dx;
                    const ny = cy + dy;
                    if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) continue;

                    const nIdx = this._idx(nx, ny);
                    if (this._blocked[nIdx] === 1) continue;

                    // No cutting corners diagonally through two walls.
                    if (dx !== 0 && dy !== 0) {
                        if (this._blocked[this._idx(cx + dx, cy)] === 1) continue;
                        if (this._blocked[this._idx(cx, cy + dy)] === 1) continue;
                    }

                    const step = dx !== 0 && dy !== 0 ? 1.4142 : 1;
                    const g = this._gScore[current] + step;

                    if (this._visitedTag[nIdx] === tag && g >= this._gScore[nIdx]) {
                        continue;
                    }

                    this._visitedTag[nIdx] = tag;
                    this._gScore[nIdx] = g;
                    this._cameFrom[nIdx] = current;

                    const gx = goalIdx % this.cols;
                    const gy = (goalIdx - gx) / this.cols;
                    const h = Math.abs(nx - gx) + Math.abs(ny - gy);

                    open.push(nIdx);
                    openF.push(g + h);
                }
            }
        }

        return null;
    }

    private _nearestOpen(cx: number, cy: number): number {
        for (let r = 1; r <= 4; r++) {
            for (let dx = -r; dx <= r; dx++) {
                for (let dy = -r; dy <= r; dy++) {
                    const nx = cx + dx;
                    const ny = cy + dy;
                    if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) continue;
                    const idx = this._idx(nx, ny);
                    if (this._blocked[idx] === 0) return idx;
                }
            }
        }
        return -1;
    }

    private _reconstruct(goalIdx: number): Vec2[] {
        const cells: number[] = [];
        let cur = goalIdx;
        while (cur !== -1) {
            cells.push(cur);
            cur = this._cameFrom[cur];
            if (cells.length > 4096) break;
        }
        cells.reverse();

        const path: Vec2[] = [];
        // Thin the path out: only keep points where the direction changes, so
        // the AI walks in straight lines rather than shuffling cell to cell.
        let lastDx = 0;
        let lastDy = 0;
        for (let i = 1; i < cells.length; i++) {
            const prev = cells[i - 1];
            const cur2 = cells[i];
            const px = prev % this.cols;
            const py = (prev - px) / this.cols;
            const cx2 = cur2 % this.cols;
            const cy2 = (cur2 - cx2) / this.cols;
            const dx = Math.sign(cx2 - px);
            const dy = Math.sign(cy2 - py);

            if ((dx !== lastDx || dy !== lastDy) && i > 1) {
                path.push(this._centre(px, py));
            }
            lastDx = dx;
            lastDy = dy;
        }

        const last = cells[cells.length - 1];
        const lx = last % this.cols;
        const ly = (last - lx) / this.cols;
        path.push(this._centre(lx, ly));

        return path;
    }
}
