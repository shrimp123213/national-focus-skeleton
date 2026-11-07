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

test('an unchanged country appears with no entries and equal shifts', () => {
  const [digest] = letterDigest(state, structuredClone(state), proposal);
  assert.equal(digest.entries.length, 0);
  assert.equal(digest.stability[0], digest.stability[1]);
});
