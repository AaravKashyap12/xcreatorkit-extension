import { describe, expect, it } from 'vitest';
import { profile, voiceMarkdown } from '../src/reply/profile';
import { personalQuestion, facts } from '../src/reply/facts';
import { drafts, prompt, SYSTEM } from '../src/reply/core';
describe('voice and personal facts', () => {
  it('uses one bounded draft and rejects multiple answers', () => {
    expect(drafts('{"drafts":["Small releases make feedback easier to use."]}')).toEqual(['Small releases make feedback easier to use.']);
    expect(() => drafts('{"drafts":["a","b"]}')).toThrow();
  });
  it('preserves legacy voice profiles and exports style without personal facts', () => {
    const p = profile({ ...profile(null), background: { work: 'private project', audience: 'Builders' }, examples: ['Small releases. Real feedback.'] });
    expect(p.background.work).toBe('private project');
    expect(voiceMarkdown(p)).toContain('Small releases. Real feedback.');
    expect(voiceMarkdown(p)).not.toContain('private project');
    const input = JSON.parse(prompt('A post', '', p));
    expect(input.explicitBackground).toBeUndefined();
  });
  it('asks for personal project and numerical answers before generation', () => {
    expect(personalQuestion('What are you building?')?.key).toBe('project');
    expect(personalQuestion('How much did you earn this month?')?.key).toBe('other');
    expect(personalQuestion('How many pages do you have indexed?')?.key).toBe('other');
    expect(personalQuestion('What makes a good product?')).toBeNull();
    expect(personalQuestion('Here is how I built my product.')).toBeNull();
    for (const post of ['Which keyboard shortcut do you use most?', 'Would you choose a boring stack or the newest framework?', 'What motivates you to keep building?', 'Tell me one mistake from your last launch.']) {
      expect(personalQuestion(post)?.key).toBe('other');
      expect(personalQuestion(post)!.question.length).toBeLessThanOrEqual(240);
    }
    expect(personalQuestion('We added keyboard shortcuts but kept visible buttons.')).toBeNull();
  });
  it('retains up to three confirmed answers and explicitly forbids invented personal claims', () => {
    const answers=[{question:'Project?',answer:'A tool'},{question:'Users?',answer:'42'}];
    expect(JSON.parse(prompt('post','',profile(null),'','',answers)).confirmedAnswers).toEqual(answers);
    expect(()=>prompt('post','',profile(null),'','',Array(4).fill(answers[0]))).toThrow();
    expect(SYSTEM).toContain('Never state first-person experiences, results, numbers or credentials the user did not supply.');
    const q=personalQuestion('intro '.repeat(60)+'How many users do you have?');
    expect(q?.question).toContain('How many users');expect(q?.question).not.toContain('intro');
  });
  it('bounds remembered answers and strips unknown fields', () => {
    expect(facts([{ key: 'project', question: 'What are you building?', answer: 'A small tool', updated: '2026-11-17', secret: 'discard' }])).toEqual([{ key: 'project', question: 'What are you building?', answer: 'A small tool', updated: '2026-11-17' }]);
    expect(facts([{ key: 'project', question: 'q', answer: 'x'.repeat(501), updated: '' }])).toEqual([]);
  });
});
