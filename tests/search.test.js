const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function dashboard() {
  const document = {
    documentElement: { getAttribute() { return null; } },
    getElementById() { return {}; },
    addEventListener() {}
  };
  const context = vm.createContext({ document, console });
  vm.runInContext(fs.readFileSync(require.resolve('../recall.js'), 'utf8'), context);
  return context;
}

const pages = [
  { title: 'Growing tomatoes in your garden', url: 'https://garden.example/tomatoes', snippet: 'Planting and watering vegetables', domain: 'garden.example' },
  { title: 'Easy homemade pasta recipe', url: 'https://recipes.example/pasta', snippet: 'Fresh tomato sauce and garlic', domain: 'recipes.example' },
  { title: 'GitHub documentation', url: 'https://github.com/docs', snippet: 'Build software together', domain: 'github.com' }
];

function search(context, query, library = pages) {
  context.library = library;
  context.query = query;
  return Array.from(vm.runInContext('state.pages = library; state.query = query; applySearch(); state.filteredPages', context));
}

test('unrelated multiword searches produce no results', () => {
  const context = dashboard();
  assert.deepEqual(search(context, 'quantum physics'), []);
  assert.deepEqual(search(context, 'garden quantum'), []);
});

test('a typo finds GitHub without unrelated gardening or pasta results', () => {
  assert.deepEqual(search(dashboard(), 'githb'), [pages[2]]);
});

test('matches exact text, partial words, typos and multiple terms', () => {
  const context = dashboard();
  assert.deepEqual(search(context, 'homemade pasta'), [pages[1]]);
  assert.deepEqual(search(context, 'tomat'), [pages[0], pages[1]]);
  assert.deepEqual(search(context, 'gardn vegetbles'), [pages[0]]);
  assert.deepEqual(search(context, 'software github'), [pages[2]]);
});

test('short unrelated words and scattered letters do not qualify as fuzzy matches', () => {
  const context = dashboard();
  assert.deepEqual(search(context, 'gthz'), []);
  assert.deepEqual(search(context, 'quantum xx'), []);
  assert.deepEqual(search(context, 'gardeningzzzz'), []);
});

test('empty search returns the full library', () => {
  assert.deepEqual(search(dashboard(), ''), pages);
});

test('fuzzy search includes pages beyond the first 300', () => {
  const library = Array.from({ length: 499 }, (_, index) => ({ title: `Garden ${index}` }));
  library.push(pages[2]);
  assert.deepEqual(search(dashboard(), 'githb', library), [pages[2]]);
});

test('session names and all saved tab titles and URLs are searchable', () => {
  const context = dashboard();
  context.sessions = [
    { name: 'Weekend research', items: Array.from({ length: 50 }, (_, index) => ({ title: `Tab ${index}`, url: 'https://example.com' })).concat([{ title: 'GitHub docs', url: 'https://github.com' }]) },
    { name: 'Recipes', items: [{ title: 'Pasta', url: 'https://food.example' }] }
  ];
  vm.runInContext('state.sessions = sessions', context);
  search(context, 'githb');
  assert.deepEqual(Array.from(vm.runInContext('state.filteredSessions', context)), [context.sessions[0]]);
  search(context, 'weekend');
  assert.deepEqual(Array.from(vm.runInContext('state.filteredSessions', context)), [context.sessions[0]]);
  search(context, 'quantum physics');
  assert.deepEqual(Array.from(vm.runInContext('state.filteredSessions', context)), []);
  search(context, '');
  assert.equal(vm.runInContext('state.filteredSessions.length', context), 2);
});
