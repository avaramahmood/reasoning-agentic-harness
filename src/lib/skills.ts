// Skills — user-authored behaviour modifiers (a markdown file with instructions
// that get injected into the model's system prompt). Like a custom persona /
// system prompt the user can add, edit, and toggle.

const API = import.meta.env.DEV ? "" : "http://127.0.0.1:8081";

export interface Skill {
  id: string;
  name: string;
  description: string;
  body: string;
}

export async function listSkills(): Promise<Skill[]> {
  try {
    const r = await fetch(`${API}/api/skills/list`);
    return r.ok ? (await r.json()).skills ?? [] : [];
  } catch {
    return [];
  }
}

export async function putSkill(s: { id?: string; name: string; description?: string; body: string }): Promise<{ id: string }> {
  const r = await fetch(`${API}/api/skills/put`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(s),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `skill put ${r.status}`);
  return j;
}

export async function deleteSkill(id: string): Promise<void> {
  await fetch(`${API}/api/skills/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
}

// Wrap a skill body as a system-prompt addendum.
export function skillSystemAddon(skill: Skill | null): string {
  if (!skill || !skill.body.trim()) return "";
  return `\n\n# Active skill: ${skill.name}\n${skill.body.trim()}`;
}
