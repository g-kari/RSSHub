import pMap from 'p-map';

export function mapInSeries<T, U>(input: Iterable<T>, mapper: (value: T, index: number) => U | Promise<U>): Promise<U[]> {
    return pMap(input, mapper, { concurrency: 1 });
}

export function collectInSeries<S, T>(initial: S, fetchPage: (state: S) => Promise<{ items: T[]; next?: S }>): Promise<T[]> {
    const items: T[] = [];
    const collect = async (state: S): Promise<T[]> => {
        const page = await fetchPage(state);
        items.push(...page.items);
        return page.next === undefined ? items : collect(page.next);
    };
    return collect(initial);
}
