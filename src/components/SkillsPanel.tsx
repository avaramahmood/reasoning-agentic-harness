// Skills manager — add/delete behaviour-modifier files. The active skill is
// chosen in the composer; this panel just curates the library.

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, X, Plus } from "lucide-react";
import { listSkills, putSkill, deleteSkill, Skill } from "../lib/skills";

export default function SkillsPanel({ refreshKey = 0, onChange }: { refreshKey?: number; onChange?: () => void }) {
  const [open, setOpen] = useState(false);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [err, setErr] = useState("");

  async function refresh() {
    setSkills(await listSkills());
  }
  useEffect(() => {
    refresh();
  }, [open, refreshKey]);

  async function add() {
    if (!name.trim() || !body.trim()) return;
    try {
      await putSkill({ name: name.trim(), description: description.trim(), body: body.trim() });
      setName("");
      setDescription("");
      setBody("");
      setAdding(false);
      refresh();
      onChange?.();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
  }

  async function remove(id: string) {
    await deleteSkill(id);
    refresh();
    onChange?.();
  }

  return (
    <div className="rounded-lg border border-border bg-card shadow-sm">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 p-3.5 text-sm font-semibold">
        <span className="text-muted-foreground">
          {open ? <ChevronDown className="h-4 w-4" strokeWidth={2.5} /> : <ChevronRight className="h-4 w-4" strokeWidth={2.5} />}
        </span>
        Skills
        <span className="rounded bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">{skills.length}</span>
        <span className="ml-auto text-[11px] font-normal text-muted-foreground">behaviour modifiers</span>
      </button>

      {open && (
        <div className="border-t border-border p-3">
          {err && <p className="mb-2 text-xs text-destructive">{err}</p>}
          <div className="space-y-2">
            {skills.map((s) => (
              <div key={s.id} className="flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-sm">
                <div className="flex-1">
                  <div className="font-semibold">{s.name}</div>
                  {s.description && <div className="text-[13px] text-muted-foreground">{s.description}</div>}
                </div>
                <button
                  onClick={() => remove(s.id)}
                  className="grid h-6 w-6 place-items-center rounded text-muted-foreground transition-colors hover:text-destructive"
                  title="Delete"
                >
                  <X className="h-3.5 w-3.5" strokeWidth={2.5} />
                </button>
              </div>
            ))}
            {!skills.length && <p className="text-xs text-muted-foreground">No skills yet.</p>}
          </div>

          {adding ? (
            <div className="mt-3 space-y-2 rounded-md border border-border p-3">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Name (e.g. Socratic Tutor)"
                className="w-full rounded-md bg-muted px-3 py-2 text-sm outline-none"
              />
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="One-line description"
                className="w-full rounded-md bg-muted px-3 py-2 text-sm outline-none"
              />
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Instructions that change how the model behaves…"
                rows={4}
                className="w-full resize-none rounded-md bg-muted px-3 py-2 text-sm outline-none"
              />
              <div className="flex gap-2">
                <button
                  onClick={add}
                  disabled={!name.trim() || !body.trim()}
                  className="rounded-md bg-primary px-4 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-40"
                >
                  Save
                </button>
                <button onClick={() => setAdding(false)} className="rounded-md px-4 py-1.5 text-xs text-muted-foreground hover:text-foreground">
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setAdding(true)}
              className="mt-3 flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={2.5} />
              Add skill
            </button>
          )}
        </div>
      )}
    </div>
  );
}
