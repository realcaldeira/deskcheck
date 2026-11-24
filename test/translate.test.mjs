import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectRunTexts, looksPortuguese, pickRunPt, stripGwt, translateRun } from '../server/translate.mjs';

test('strips GWT prefix cleanly and detects language', () => {
  assert.equal(stripGwt('Given: The user opens the form'), 'The user opens the form');
  assert.equal(stripGwt('When The user clicks Save'), 'The user clicks Save');
  assert.equal(looksPortuguese('O usuário abre o formulário'), true);
  assert.equal(looksPortuguese('The user opens the report registration form in the admin panel'), false);
});

test('collects English card, test case, defect and mark texts and picks cached PT translations', async () => {
  const run = {
    type: 'Feature',
    title: 'Total Videos Big Number',
    card: {
      type: 'Feature',
      title: 'Total Videos Big Number',
      state: 'Waiting Quality Analysis',
      testCases: [{
        id: 1,
        title: 'User registers the total value in the admin panel',
        steps: [
          { action: 'Given: The user opens the report registration form in the admin panel', expected: '' },
          { action: 'When: The user enters a valid total number of videos for the topic', expected: '' },
          { action: 'Then: The system validates and saves the value', expected: '' },
        ],
      }],
    },
    result: {
      defects: [{ title: '[FRONT] Missing counter', steps: '1. Open page', expected: 'Counter shown', actual: 'Hidden' }],
    },
    shots: [{ marks: [{ n: 1, note: 'Card clipped at 768px' }] }],
  };
  const texts = collectRunTexts(run);
  assert.ok(texts.includes('The user opens the report registration form in the admin panel'));
  assert.ok(texts.includes('User registers the total value in the admin panel'));
  assert.ok(texts.includes('Card clipped at 768px'));

  const cache = {
    'The user opens the report registration form in the admin panel': 'O usuário abre o formulário de registro do relatório no painel de administração',
  };
  await translateRun(run, cache, null, { simulate: true });
  assert.equal(run.pt['Feature'], 'Funcionalidade');
  assert.equal(run.pt['Waiting Quality Analysis'], 'Aguardando Análise de Qualidade');
  assert.equal(
    run.pt['The user opens the report registration form in the admin panel'],
    'O usuário abre o formulário de registro do relatório no painel de administração',
  );
  assert.equal(pickRunPt(run, cache)['Feature'], 'Funcionalidade');
});
