import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, installCountry, startFocus } from '../src/engine';
import { demoTree } from '../src/demo';
import { EventSchema, ProposalSchema } from '../src/model';
import { letterDigest } from '../src/proposal-view';

const tree = demoTree('land', '试验国');
const state = startFocus(installCountry(createState(100), { ...tree, historical: [] }, 100), 'land', tree.nodes[0].id);
const proposal = ProposalSchema.parse({ id: 'p', until: 130, reason: 'r', steps: [], edits: [], calibrations: [], transitions: [] });

test('letter digest lists starts, completions, events and shifts in story order', () => {
  const preview = structuredClone(state);
  const country = preview.countries.land;
  const first = tree.nodes[0].id;
  const next = tree.nodes.find((node) => node.prerequisites.flat().includes(first))!.id;
  Object.assign(country.progress[first], { status: 'completed', completed: 121, days: tree.nodes[0].days });
  Object.assign(country.progress[next], { status: 'active', started: 121 });
  country.current = next;
  country.stability += 4;
  preview.events.ev = EventSchema.parse({
    id: 'ev',
    at: 110,
    countries: ['land'],
    title: '边境试探',
    description: '斥候越境',
    evidence: '世界局势',
    origin: 'background',
    public: false,
    changes: [],
  });
  const facts = ProposalSchema.parse({
    ...proposal,
    steps: [
      {
        at: 105,
        facts: [{ country: 'land', id: 'f', value: true, evidence: '港口可用', origin: 'story' }],
        events: [],
        selections: [],
        publications: [],
        eventUpdates: [],
      },
    ],
    transitions: [{ country: 'land', cause: 'completed', reason: '议程完成', invalidateActive: false }],
  });
  const [digest] = letterDigest(state, preview, facts);
  assert.equal(digest.id, 'land');
  assert.deepEqual(digest.stability, [state.countries.land.stability, state.countries.land.stability + 4]);
  assert.equal(digest.focus[1], tree.nodes.find((node) => node.id === next)!.name);
  const kinds = digest.entries.map((entry) => entry.kind);
  assert.deepEqual(kinds, ['fact', 'event', 'complete', 'start', 'transition']);
  assert.ok(digest.entries.every((entry, i, all) => i === 0 || all[i - 1].day <= entry.day));
  assert.equal(digest.entries[1].note, '未公开');
});

test('a change of government names the new faction and says pending when the player decides', () => {
  const preview = structuredClone(state);
  preview.countries.land.politics = {
    ruling: 'crown',
    factions: [
      { id: 'crown', name: '皇权派', appeal: '王权', stance: 'hardline', support: 60, color: 0 },
      { id: 'cabinet', name: '内阁派', appeal: '议会', stance: 'moderate', support: 40, color: 1 },
    ],
    members: [],
    succession: '议会推举',
  };
  const government = ProposalSchema.parse({
    ...proposal,
    transitions: [{ country: 'land', cause: 'government', ruling: 'cabinet', reason: '议会罢免首相' }],
  });
  const title = (country: typeof preview.countries.land) =>
    letterDigest(state, { ...preview, countries: { land: country } }, government)[0].entries[0];
  const automatic = title(preview.countries.land);
  assert.equal(automatic.title, '政权易手：「内阁派」接掌，进入下一期');
  assert.equal(automatic.note, '议会罢免首相');
  const pending = '政权易手待决：「内阁派」将接掌，由玩家决定是否换期';
  assert.equal(title({ ...preview.countries.land, autoPeriod: false }).title, pending);
  assert.equal(title({ ...preview.countries.land, calibration: true }).title, pending);
});

test('an unchanged country appears with no entries and equal shifts', () => {
  const [digest] = letterDigest(state, structuredClone(state), proposal);
  assert.equal(digest.entries.length, 0);
  assert.equal(digest.stability[0], digest.stability[1]);
});
