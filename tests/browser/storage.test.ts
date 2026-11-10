import { expect, test } from "vitest";
import { LevelStorage } from "../../lib/storage/level";

test("fresh Level initialization clears persisted IndexedDB state", async () => {
    const name = `ldes-fresh-${Date.now()}-${Math.random()}`;
    const first = new LevelStorage(name);
    await first.init();
    await first.store<string, string>("members").put("old", "saved");
    await first.close();
    const second = new LevelStorage(name);
    try {
        await second.init(true);
        expect(await second.store<string, string>("members").get("old")).toBeUndefined();
    } finally {
        await second.close();
    }
});
