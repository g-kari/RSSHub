import { describe, expect, it } from 'vitest';

import { collectInSeries, mapInSeries } from './sequence';

describe('sequential request processing', () => {
    it('preserves shared-resource order and never overlaps requests', async () => {
        const order: string[] = [];
        let active = 0;
        let maximum = 0;
        const result = await mapInSeries([1, 2, 3], async (value) => {
            active++;
            maximum = Math.max(maximum, active);
            order.push(`start:${value}`);
            await Promise.resolve();
            order.push(`end:${value}`);
            active--;
            return value * 2;
        });
        expect(result).toEqual([2, 4, 6]);
        expect(order).toEqual(['start:1', 'end:1', 'start:2', 'end:2', 'start:3', 'end:3']);
        expect(maximum).toBe(1);
    });

    it('stops before the next item and propagates mapper failures', async () => {
        const seen: number[] = [];
        await expect(
            mapInSeries([1, 2, 3], (value) => {
                seen.push(value);
                if (value === 2) {
                    throw new Error('shared tab failed');
                }
                return value;
            })
        ).rejects.toThrow('shared tab failed');
        expect(seen).toEqual([1, 2]);
    });
});

describe('sequential pagination', () => {
    it('waits for each page and collects offsets and items in order until next is absent', async () => {
        const offsets: number[] = [];
        let active = 0;
        let maximum = 0;
        const items = await collectInSeries(0, async (offset) => {
            active++;
            maximum = Math.max(maximum, active);
            offsets.push(offset);
            await Promise.resolve();
            active--;
            return { items: [offset], next: offset < 1000 ? offset + 500 : undefined };
        });
        expect(offsets).toEqual([0, 500, 1000]);
        expect(items).toEqual([0, 500, 1000]);
        expect(maximum).toBe(1);
    });

    it('keeps preceding items when a later page signals a normal stop', async () => {
        const offsets: number[] = [];
        const items = await collectInSeries(0, (offset) => {
            offsets.push(offset);
            return Promise.resolve(offset === 0 ? { items: ['first'], next: 500 } : { items: [] });
        });
        expect(items).toEqual(['first']);
        expect(offsets).toEqual([0, 500]);
    });

    it('terminates on an empty initial page without requesting another page', async () => {
        const offsets: number[] = [];
        expect(
            await collectInSeries(0, (offset) => {
                offsets.push(offset);
                return Promise.resolve({ items: [] as string[] });
            })
        ).toEqual([]);
        expect(offsets).toEqual([0]);
    });

    it('propagates page failures without requesting subsequent offsets', async () => {
        const offsets: number[] = [];
        await expect(
            collectInSeries(0, (offset) => {
                offsets.push(offset);
                return offset === 0 ? Promise.resolve({ items: ['first'], next: 500 }) : Promise.reject(new Error('page failed'));
            })
        ).rejects.toThrow('page failed');
        expect(offsets).toEqual([0, 500]);
    });
});
