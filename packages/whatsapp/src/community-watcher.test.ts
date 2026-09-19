import assert from "node:assert/strict";
import test from "node:test";
import { CommunityWatcher } from "./community-watcher.ts";
import { GroupAllowlist } from "./group-allowlist.ts";
import type { GroupSummary } from "./whatsapp-session.ts";

const community = "120363403826145518@g.us";

function group(id: string, overrides: Partial<GroupSummary> = {}): GroupSummary {
  return { id, subject: `group ${id}`, members: 10, botIsAdmin: false, community: "member", communityId: community,
    ...overrides };
}

test("watches this community's member groups once each, and nothing else", async () => {
  const allowlist = new GroupAllowlist(["120363404850670523@g.us"]);
  const watched: string[] = [];
  let groups: GroupSummary[] = [
    group("120363404850670523@g.us"),
    group(community, { community: "parent" }),
    group("120363421947016065@g.us", { community: "announcements" }),
    group("120363000000000777@g.us", { communityId: "120363000000000999@g.us" }),
    group("120363000000000888@g.us", { community: "none" }),
  ];
  const watcher = new CommunityWatcher({
    communityId: community, allowlist, listGroups: async () => groups, onWatched: (added) => void watched.push(added.id),
  });

  assert.equal(await watcher.refresh(), 0);
  groups = [...groups, group("120363000000000555@g.us")];
  const [first, second] = await Promise.all([watcher.refresh(), watcher.refresh()]);
  assert.equal(first + second, 2, "overlapping refreshes share one check");
  assert.equal(await watcher.refresh(), 0);

  assert.deepEqual(watched, ["120363000000000555@g.us"]);
  assert.deepEqual(allowlist.list(), ["120363404850670523@g.us", "120363000000000555@g.us"]);
});

test("a failing notification does not undo watching", async () => {
  const allowlist = new GroupAllowlist();
  const watcher = new CommunityWatcher({
    communityId: community, allowlist, listGroups: async () => [group("120363000000000555@g.us")],
    onWatched: () => { throw new Error("send failed"); },
  });

  assert.equal(await watcher.refresh(), 1);
  assert.equal(allowlist.has("120363000000000555@g.us"), true);
});

test("the allowlist rejects invalid or duplicate IDs", () => {
  assert.throws(() => new GroupAllowlist(["not-a-group"]));
  assert.throws(() => new GroupAllowlist(["1@g.us", "1@g.us"]));
  const allowlist = new GroupAllowlist(["1@g.us"]);
  assert.equal(allowlist.add("1@g.us"), false);
  assert.equal(allowlist.add("61400000001@s.whatsapp.net"), false);
});
