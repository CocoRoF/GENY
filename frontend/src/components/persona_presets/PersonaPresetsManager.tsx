'use client';

/**
 * Persona Presets — the Geny persona builder.
 *
 * A reusable library of structured persona definitions (MBTI/Enneagram/archetype
 * + OCEAN + expressive-style sliders + Korean register + emotion defaults +
 * identity). The builder compiles live to the persona prompt the backend will
 * inject when an environment attaches the preset
 * (host_selections.extras.persona_preset_id, set via the env editor's Persona
 * panel). `embedded` renders it inside the environment-management shell.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Plus, ArrowLeft, Trash2, Save, Sparkles, Loader2, Wand2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import {
  personaPresetsApi,
  type PersonaPresetSummary,
  type PersonaPresetDefinition,
  type PersonaFrameworks,
} from '@/lib/api';

const EMPTY: PersonaPresetDefinition = {
  name: '',
  description: '',
  mbti: '',
  enneagram: '',
  archetype: '',
  ocean: { openness: 50, conscientiousness: 50, extraversion: 50, agreeableness: 50, neuroticism: 50 },
  style: { warmth: 50, humor: 50, playfulness: 50, formality: 50, assertiveness: 50, verbosity: 50, emoji: 50, enthusiasm: 50, directness: 50 },
  speech: { honorific: 'auto', self_reference: '', catchphrases: [], verbal_tics: [] },
  emotion: { default_mood: 'neutral', expressiveness: 50, preferred_tags: [] },
  identity: { display_name: '', age_vibe: '', role: '', interests: [], backstory: '' },
  prompt_override: '',
};

const clone = (d: PersonaPresetDefinition): PersonaPresetDefinition =>
  JSON.parse(JSON.stringify(d));

export default function PersonaPresetsManager({ embedded = false }: { embedded?: boolean }) {
  const { t } = useI18n();
  const [presets, setPresets] = useState<PersonaPresetSummary[]>([]);
  const [frameworks, setFrameworks] = useState<PersonaFrameworks | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<'list' | 'edit'>('list');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<PersonaPresetDefinition>(clone(EMPTY));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = await personaPresetsApi.list();
      setPresets(p.presets);
      if (!frameworks) setFrameworks(await personaPresetsApi.frameworks());
    } catch (e) {
      toast.error(t('personaPresets.failed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setLoading(false);
    }
  }, [t, frameworks]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openNew = () => {
    setEditingId(null);
    setDraft(clone(EMPTY));
    setMode('edit');
  };

  const openEdit = async (id: string) => {
    try {
      const full = await personaPresetsApi.get(id);
      setEditingId(id);
      setDraft({ ...clone(EMPTY), ...full });
      setMode('edit');
    } catch (e) {
      toast.error(t('personaPresets.failed', { error: e instanceof Error ? e.message : String(e) }));
    }
  };

  const remove = async (p: PersonaPresetSummary) => {
    if (!window.confirm(t('personaPresets.deleteConfirm', { name: p.name }))) return;
    try {
      await personaPresetsApi.remove(p.id);
      toast.success(t('personaPresets.deleted', { name: p.name }));
      void load();
    } catch (e) {
      toast.error(t('personaPresets.failed', { error: e instanceof Error ? e.message : String(e) }));
    }
  };

  const save = async () => {
    if (!draft.name.trim()) {
      toast.error(t('personaPresets.nameRequired'));
      return;
    }
    try {
      if (editingId) await personaPresetsApi.update(editingId, draft);
      else await personaPresetsApi.create(draft);
      toast.success(t('personaPresets.saved', { name: draft.name }));
      setMode('list');
      void load();
    } catch (e) {
      toast.error(t('personaPresets.failed', { error: e instanceof Error ? e.message : String(e) }));
    }
  };

  const wrap = embedded
    ? 'flex-1 min-h-0 overflow-y-auto px-1 py-1'
    : 'min-h-screen bg-[hsl(var(--background))] px-4 md:px-8 py-6';

  if (mode === 'edit' && frameworks) {
    return (
      <div className={wrap}>
        <Editor
          draft={draft}
          setDraft={setDraft}
          frameworks={frameworks}
          editing={!!editingId}
          onBack={() => setMode('list')}
          onSave={save}
        />
      </div>
    );
  }

  return (
    <div className={wrap}>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-[0.95rem] font-semibold text-[hsl(var(--foreground))] flex items-center gap-2">
            <Sparkles size={16} className="text-violet-500" />
            {t('personaPresets.title')}
          </h2>
          <p className="text-[0.75rem] text-[hsl(var(--muted-foreground))] mt-0.5">
            {t('personaPresets.subtitle')}
          </p>
        </div>
        <button
          onClick={openNew}
          className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md bg-violet-600 hover:bg-violet-500 text-white text-[0.8125rem] font-medium transition-colors"
        >
          <Plus size={15} /> {t('personaPresets.new')}
        </button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-[0.8125rem] text-[hsl(var(--muted-foreground))] py-10 justify-center">
          <Loader2 size={15} className="animate-spin" /> {t('personaPresets.loading')}
        </div>
      ) : presets.length === 0 ? (
        <div className="text-center py-12 border border-dashed border-[hsl(var(--border))] rounded-lg">
          <p className="text-[0.85rem] font-medium text-[hsl(var(--foreground))]">{t('personaPresets.empty.title')}</p>
          <p className="text-[0.75rem] text-[hsl(var(--muted-foreground))] mt-1">{t('personaPresets.empty.desc')}</p>
        </div>
      ) : (
        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {presets.map((p) => (
            <div
              key={p.id}
              className="group rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-3.5 hover:border-violet-400/50 transition-colors cursor-pointer flex flex-col"
              onClick={() => openEdit(p.id)}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="text-[0.85rem] font-semibold text-[hsl(var(--foreground))] leading-snug">{p.name}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); void remove(p); }}
                  className="opacity-0 group-hover:opacity-100 text-[hsl(var(--muted-foreground))] hover:text-rose-500 transition-all shrink-0"
                  title={t('personaPresets.delete')}
                >
                  <Trash2 size={14} />
                </button>
              </div>
              {p.description && (
                <p className="text-[0.72rem] text-[hsl(var(--muted-foreground))] mt-1 line-clamp-2">{p.description}</p>
              )}
              <div className="flex flex-wrap gap-1 mt-2.5">
                {p.mbti && <Chip>{p.mbti}</Chip>}
                {p.enneagram && <Chip>E{p.enneagram}</Chip>}
                {p.archetype && <Chip>{p.archetype}</Chip>}
                {p.is_template && <Chip muted>{t('personaPresets.template')}</Chip>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Chip({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return (
    <span
      className={
        'text-[0.65rem] px-1.5 py-0.5 rounded ' +
        (muted
          ? 'bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]'
          : 'bg-violet-500/10 text-violet-600 dark:text-violet-300')
      }
    >
      {children}
    </span>
  );
}

// ──────────────────────────────────────────────────────────────────────────

function Editor({
  draft,
  setDraft,
  frameworks,
  editing,
  onBack,
  onSave,
}: {
  draft: PersonaPresetDefinition;
  setDraft: (d: PersonaPresetDefinition) => void;
  frameworks: PersonaFrameworks;
  editing: boolean;
  onBack: () => void;
  onSave: () => void;
}) {
  const { t } = useI18n();
  const [preview, setPreview] = useState('');
  const [compiling, setCompiling] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Live compile (debounced) so the author sees the actual injected prompt.
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    setCompiling(true);
    timer.current = setTimeout(async () => {
      try {
        const r = await personaPresetsApi.compile(draft);
        setPreview(r.compiled_prompt);
      } catch {
        /* preview is best-effort */
      } finally {
        setCompiling(false);
      }
    }, 350);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [draft]);

  const patch = (p: Partial<PersonaPresetDefinition>) => setDraft({ ...draft, ...p });
  const patchOcean = (k: keyof PersonaPresetDefinition['ocean'], v: number) =>
    setDraft({ ...draft, ocean: { ...draft.ocean, [k]: v } });
  const patchStyle = (k: keyof PersonaPresetDefinition['style'], v: number) =>
    setDraft({ ...draft, style: { ...draft.style, [k]: v } });
  const patchSpeech = (p: Partial<PersonaPresetDefinition['speech']>) =>
    setDraft({ ...draft, speech: { ...draft.speech, ...p } });
  const patchEmotion = (p: Partial<PersonaPresetDefinition['emotion']>) =>
    setDraft({ ...draft, emotion: { ...draft.emotion, ...p } });
  const patchIdentity = (p: Partial<PersonaPresetDefinition['identity']>) =>
    setDraft({ ...draft, identity: { ...draft.identity, ...p } });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between sticky top-0 z-10 bg-[hsl(var(--background))] py-1">
        <button onClick={onBack} className="inline-flex items-center gap-1.5 text-[0.8125rem] text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--foreground))]">
          <ArrowLeft size={15} /> {t('personaPresets.back')}
        </button>
        <button onClick={onSave} className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-md bg-violet-600 hover:bg-violet-500 text-white text-[0.8125rem] font-medium">
          <Save size={15} /> {editing ? t('personaPresets.update') : t('personaPresets.create')}
        </button>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        {/* ── left: the builder form ── */}
        <div className="flex flex-col gap-5">
          <Section title={t('personaPresets.sections.basic')}>
            <Text label={t('personaPresets.f.name')} value={draft.name} onChange={(v) => patch({ name: v })} placeholder="예: 밝은 비서" />
            <Text label={t('personaPresets.f.description')} value={draft.description} onChange={(v) => patch({ description: v })} />
          </Section>

          <Section title={t('personaPresets.sections.framework')}>
            <div className="grid grid-cols-3 gap-2">
              <Select label="MBTI" value={draft.mbti} onChange={(v) => patch({ mbti: v })}
                options={[{ value: '', label: '—' }, ...frameworks.mbti.map((m) => ({ value: m.code, label: `${m.code} ${m.label_ko}` }))]} />
              <Select label="Enneagram" value={draft.enneagram} onChange={(v) => patch({ enneagram: v })}
                options={[{ value: '', label: '—' }, ...frameworks.enneagram.map((m) => ({ value: m.code, label: `${m.code} ${m.label_ko}` }))]} />
              <Select label={t('personaPresets.f.archetype')} value={draft.archetype} onChange={(v) => patch({ archetype: v })}
                options={[{ value: '', label: '—' }, ...frameworks.archetypes.map((m) => ({ value: m.code, label: m.label_ko }))]} />
            </div>
          </Section>

          <Section title={t('personaPresets.sections.ocean')}>
            {frameworks.ocean_axes.map((a) => (
              <Slider key={a.key} label={a.label_ko} low={a.low} high={a.high}
                value={(draft.ocean as unknown as Record<string, number>)[a.key] ?? 50}
                onChange={(v) => patchOcean(a.key as keyof PersonaPresetDefinition['ocean'], v)} />
            ))}
          </Section>

          <Section title={t('personaPresets.sections.style')}>
            {frameworks.style_axes.map((a) => (
              <Slider key={a.key} label={a.label_ko} low={a.low} high={a.high}
                value={(draft.style as unknown as Record<string, number>)[a.key] ?? 50}
                onChange={(v) => patchStyle(a.key as keyof PersonaPresetDefinition['style'], v)} />
            ))}
          </Section>

          <Section title={t('personaPresets.sections.speech')}>
            <Select label={t('personaPresets.f.honorific')} value={draft.speech.honorific} onChange={(v) => patchSpeech({ honorific: v })}
              options={frameworks.honorifics.map((h) => ({ value: h.code, label: h.label_ko }))} />
            <Text label={t('personaPresets.f.selfReference')} value={draft.speech.self_reference} onChange={(v) => patchSpeech({ self_reference: v })} placeholder="예: 나, 저, 이름" />
            <CommaList label={t('personaPresets.f.catchphrases')} value={draft.speech.catchphrases} onChange={(v) => patchSpeech({ catchphrases: v })} />
            <CommaList label={t('personaPresets.f.verbalTics')} value={draft.speech.verbal_tics} onChange={(v) => patchSpeech({ verbal_tics: v })} />
          </Section>

          <Section title={t('personaPresets.sections.emotion')}>
            <Select label={t('personaPresets.f.defaultMood')} value={draft.emotion.default_mood} onChange={(v) => patchEmotion({ default_mood: v })}
              options={frameworks.emotion_tags.map((tag) => ({ value: tag, label: tag }))} />
            <Slider label={t('personaPresets.f.expressiveness')} low={t('personaPresets.low')} high={t('personaPresets.high')}
              value={draft.emotion.expressiveness} onChange={(v) => patchEmotion({ expressiveness: v })} />
            <TagPicker label={t('personaPresets.f.preferredTags')} all={frameworks.emotion_tags}
              value={draft.emotion.preferred_tags} onChange={(v) => patchEmotion({ preferred_tags: v })} />
          </Section>

          <Section title={t('personaPresets.sections.identity')}>
            <div className="grid grid-cols-2 gap-2">
              <Text label={t('personaPresets.f.displayName')} value={draft.identity.display_name} onChange={(v) => patchIdentity({ display_name: v })} />
              <Text label={t('personaPresets.f.ageVibe')} value={draft.identity.age_vibe} onChange={(v) => patchIdentity({ age_vibe: v })} placeholder="예: 또래 친구" />
            </div>
            <Text label={t('personaPresets.f.role')} value={draft.identity.role} onChange={(v) => patchIdentity({ role: v })} placeholder="예: 다정한 AI 친구" />
            <CommaList label={t('personaPresets.f.interests')} value={draft.identity.interests} onChange={(v) => patchIdentity({ interests: v })} />
            <Area label={t('personaPresets.f.backstory')} value={draft.identity.backstory} onChange={(v) => patchIdentity({ backstory: v })} rows={3} />
          </Section>
        </div>

        {/* ── right: live preview + override ── */}
        <div className="flex flex-col gap-3 lg:sticky lg:top-12 lg:self-start">
          <div className="rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--muted))]/40 p-3.5">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[0.78rem] font-semibold text-[hsl(var(--foreground))] flex items-center gap-1.5">
                <Wand2 size={14} className="text-violet-500" /> {t('personaPresets.preview')}
              </span>
              <span className="text-[0.65rem] text-[hsl(var(--muted-foreground))] font-mono">
                {compiling ? '…' : `${preview.length} chars`}
              </span>
            </div>
            <pre className="whitespace-pre-wrap text-[0.72rem] leading-relaxed text-[hsl(var(--foreground))] font-mono max-h-[40vh] overflow-y-auto">
              {preview || t('personaPresets.previewEmpty')}
            </pre>
          </div>
          <Area
            label={t('personaPresets.f.override')}
            hint={t('personaPresets.overrideHint')}
            value={draft.prompt_override}
            onChange={(v) => patch({ prompt_override: v })}
            rows={4}
          />
        </div>
      </div>
    </div>
  );
}

// ── primitives (hsl token system, to match the env-editor neighbours) ──

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5">
      <h3 className="text-[0.7rem] font-semibold uppercase tracking-wide text-[hsl(var(--muted-foreground))]">{title}</h3>
      <div className="flex flex-col gap-2.5">{children}</div>
    </div>
  );
}

const inputCls =
  'w-full h-9 px-2.5 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.8125rem] text-[hsl(var(--foreground))] focus:outline-none focus:ring-2 focus:ring-violet-500/40';

function Lbl({ children }: { children: React.ReactNode }) {
  return <label className="text-[0.72rem] font-medium text-[hsl(var(--foreground))]">{children}</label>;
}

function Text({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <Lbl>{label}</Lbl>
      <input className={inputCls} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function Area({ label, value, onChange, rows = 3, hint }: { label: string; value: string; onChange: (v: string) => void; rows?: number; hint?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <Lbl>{label}</Lbl>
      <textarea
        rows={rows}
        className="w-full px-2.5 py-2 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--background))] text-[0.8125rem] text-[hsl(var(--foreground))] focus:outline-none focus:ring-2 focus:ring-violet-500/40 resize-y"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <span className="text-[0.65rem] text-[hsl(var(--muted-foreground))]">{hint}</span>}
    </div>
  );
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <div className="flex flex-col gap-1">
      <Lbl>{label}</Lbl>
      <select className={inputCls} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

function Slider({ label, low, high, value, onChange }: { label: string; low: string; high: string; value: number; onChange: (v: number) => void }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-0.5">
        <span className="text-[0.72rem] font-medium text-[hsl(var(--foreground))]">{label}</span>
        <span className="text-[0.65rem] font-mono text-[hsl(var(--muted-foreground))]">{value}</span>
      </div>
      <input type="range" min={0} max={100} value={value} onChange={(e) => onChange(parseInt(e.target.value, 10))} className="w-full accent-violet-600" />
      <div className="flex items-center justify-between text-[0.6rem] text-[hsl(var(--muted-foreground))]">
        <span>{low}</span><span>{high}</span>
      </div>
    </div>
  );
}

function CommaList({ label, value, onChange }: { label: string; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <Text
      label={label}
      value={value.join(', ')}
      onChange={(v) => onChange(v.split(',').map((s) => s.trim()).filter(Boolean))}
      placeholder="쉼표로 구분"
    />
  );
}

function TagPicker({ label, all, value, onChange }: { label: string; all: string[]; value: string[]; onChange: (v: string[]) => void }) {
  const toggle = (tag: string) =>
    onChange(value.includes(tag) ? value.filter((x) => x !== tag) : [...value, tag]);
  return (
    <div className="flex flex-col gap-1.5">
      <Lbl>{label}</Lbl>
      <div className="flex flex-wrap gap-1.5">
        {all.map((tag) => {
          const on = value.includes(tag);
          return (
            <button
              key={tag}
              type="button"
              onClick={() => toggle(tag)}
              className={
                'text-[0.68rem] px-2 py-0.5 rounded-full border transition-colors ' +
                (on
                  ? 'bg-violet-600 border-violet-600 text-white'
                  : 'border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))] hover:border-violet-400')
              }
            >
              {tag}
            </button>
          );
        })}
      </div>
    </div>
  );
}
