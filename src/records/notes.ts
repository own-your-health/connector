// notes.md as medrec reads it (medrec-cli src/notes.rs): `## <date> (<id>)`
// headings, optional `Tags:`, `About:` and `By:` lines, then the text.

import type { Note } from './model';
import { lines, trim } from './text';

const NOTE_ID = /^n_[a-z2-7]{20}$/;

export async function parseNotes(text: string): Promise<Note[]> {
  const notes: Note[] = [];
  let current: { date: string; id?: string; lines: string[] } | null = null;
  const flush = async () => {
    if (current) notes.push(await build(current.date, current.id, current.lines));
  };
  for (const line of lines(text)) {
    if (line.startsWith('## ')) {
      await flush();
      const head = trim(line.slice(3));
      const sp = head.indexOf(' ');
      if (sp === -1) {
        current = { date: head, lines: [] };
      } else {
        const rest = trim(head.slice(sp + 1));
        const id = trim(rest.replace(/^\(+/, '').replace(/\)+$/, ''));
        current = { date: head.slice(0, sp), ...(NOTE_ID.test(id) ? { id } : {}), lines: [] };
      }
    } else if (current) {
      current.lines.push(line);
    }
  }
  await flush();
  return notes;
}

const list = (v: string) =>
  v
    .split(',')
    .map(trim)
    .filter((s) => s !== '');

async function build(date: string, id: string | undefined, ls: string[]): Promise<Note> {
  let tags: string[] = [];
  let about: string[] = [];
  let author: string | undefined;
  let i = 0;
  for (; i < ls.length; i++) {
    const l = ls[i]!;
    if (l.startsWith('Tags:')) tags = list(l.slice(5));
    else if (l.startsWith('About:')) about = list(l.slice(6));
    else if (l.startsWith('By:')) author = trim(l.slice(3)) || undefined;
    else break;
  }
  const text = trim(
    ls
      .slice(i)
      .map((l) => (l.startsWith('\\') ? l.slice(1) : l))
      .join('\n'),
  );
  const noteId = id ?? `n_${(await sha256Hex(`${date}\n${text}`)).slice(0, 20)}`;
  return { id: noteId, date, ...(author !== undefined ? { author } : {}), text, tags, about };
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
