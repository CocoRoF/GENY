'use client';

/**
 * CustomToolFormModal — create / edit a DB-backed custom tool.
 *
 * Sectioned panel inside `RegistryFormShell` (same chrome the MCP /
 * SKILLS / HOOK editors use). Three sections matter:
 *
 *   1. 기본 정보       — name (lowercase snake_case), description,
 *                        input_schema (raw JSON; visual builder is a
 *                        Phase C follow-up — for the first cut we
 *                        trust the operator to write JSON Schema
 *                        directly + we surface live parse status).
 *   2. 백엔드 설정     — pick HTTP / MCP-Proxy / Builtin-Alias, then
 *                        render the matching sub-form.
 *   3. 테스트          — args JSON + dry-run / real-call preview
 *                        against ``POST /api/custom-tools/{id}/test``.
 *                        Only available after the row exists (id != null).
 *
 * The form is intentionally compact and trusts the backend's pydantic
 * validators for the deep checks — failure messages from the API land
 * in the shell's red banner verbatim.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Box,
  CheckCircle2,
  Code2,
  Globe,
  Link2,
  Play,
  Save,
  Wrench,
  XCircle,
} from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import {
  customToolsApi,
  type CustomToolBackendKind,
  type CustomToolDetail,
  type CustomToolPayload,
  type CustomToolTestResponse,
} from '@/lib/api';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import RegistryFormShell from '@/components/env_management/registry/RegistryFormShell';

export interface CustomToolFormSubmit {
  /** Defined when editing an existing row, undefined when creating. */
  id?: string;
  body: CustomToolPayload;
}

interface Props {
  editing: CustomToolDetail | null;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (payload: CustomToolFormSubmit) => void;
}

const KIND_LABELS: Record<CustomToolBackendKind, string> = {
  http: 'HTTP API',
  mcp_proxy: 'MCP Proxy',
  python_inline: 'Python (Inline)',
  builtin_alias: 'Builtin Alias',
};
const KIND_ICONS: Record<CustomToolBackendKind, typeof Wrench> = {
  http: Globe,
  mcp_proxy: Link2,
  python_inline: Code2,
  builtin_alias: Wrench,
};
const KIND_HINTS: Record<CustomToolBackendKind, string> = {
  http: '외부 HTTP API 호출. URL/헤더/본문 템플릿에서 ${arg:foo}, ${secret:KEY}, ${session:session_id} 치환 가능',
  mcp_proxy: '이미 등록된 MCP 서버의 도구를 다른 이름·스키마로 재노출',
  python_inline:
    'BaseTool 서브클래스를 Python 으로 직접 작성. service.* / geny_executor.* 모두 import 가능. host-admin 권한으로 실행.',
  builtin_alias:
    '(legacy) backend/tools/custom/*_tools.py 의 Python 도구에 메타데이터 오버레이만 적용 — 신규 도구는 python_inline 권장',
};

// Backend kinds the new-tool form lets you pick. ``builtin_alias`` is
// kept in the type union for backward-compat (existing rows still load
// correctly) but hidden from the picker — write the actual Python via
// ``python_inline`` instead so the tool lives in the web, not the repo.
const NEW_TOOL_KINDS: CustomToolBackendKind[] = [
  'http',
  'mcp_proxy',
  'python_inline',
];

const DEFAULT_SCHEMA = {
  type: 'object',
  properties: {},
  required: [] as string[],
  additionalProperties: false,
};

const DEFAULT_HTTP_CFG = {
  method: 'POST',
  url_template: 'https://api.example.com/endpoint',
  headers: { 'Content-Type': 'application/json' },
  body_template: null,
  timeout_seconds: 30,
  response_handler: 'json',
  sse_done_marker: null,
};
const DEFAULT_MCP_CFG = {
  upstream_mcp_server: '',
  upstream_tool_name: '',
  schema_overlay: null,
};
const DEFAULT_ALIAS_CFG = {
  source_module: '',
  source_class: '',
  description_override: null,
  examples_override: null,
};
const DEFAULT_PYTHON_CFG = {
  source_code: `from tools.base import BaseTool, ToolError

class MyCustomTool(BaseTool):
    name = "my_custom_tool"
    description = "Describe what this tool does for the LLM."

    def run(self, query: str) -> str:
        # The host strips host-injected kwargs (session_id) before they
        # reach this method. Raise ToolError(\"...\") for clean failures
        # — the bridge surfaces it as isError=True with the message text.
        return f"You asked: {query}"
`,
  class_name: 'MyCustomTool',
};

function defaultConfigFor(kind: CustomToolBackendKind): Record<string, unknown> {
  if (kind === 'http') return { ...DEFAULT_HTTP_CFG };
  if (kind === 'mcp_proxy') return { ...DEFAULT_MCP_CFG };
  if (kind === 'python_inline') return { ...DEFAULT_PYTHON_CFG };
  return { ...DEFAULT_ALIAS_CFG };
}

export default function CustomToolFormModal({
  editing,
  saving,
  error,
  onClose,
  onSubmit,
}: Props) {
  const { t } = useI18n();

  const isEdit = editing != null;
  const [name, setName] = useState(editing?.name ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  const [enabled, setEnabled] = useState<boolean>(editing?.enabled ?? true);
  const [kind, setKind] = useState<CustomToolBackendKind>(
    editing?.backend_kind ?? 'http',
  );

  // Free-form JSON editors. We round-trip via stringify so the user
  // can hand-edit the structure; bad JSON surfaces in the parse chip.
  const [schemaText, setSchemaText] = useState(
    JSON.stringify(editing?.input_schema ?? DEFAULT_SCHEMA, null, 2),
  );
  const [configText, setConfigText] = useState(
    JSON.stringify(editing?.config ?? defaultConfigFor(kind), null, 2),
  );

  // Test panel state.
  const [testArgsText, setTestArgsText] = useState('{}');
  const [testDryRun, setTestDryRun] = useState(true);
  const [testRunning, setTestRunning] = useState(false);
  const [testResult, setTestResult] = useState<CustomToolTestResponse | null>(
    null,
  );

  // When the operator switches kind in a *new* tool, reseed config
  // with the new default. For edits, leave the loaded config alone so
  // we don't blow away the user's settings.
  useEffect(() => {
    if (isEdit) return;
    setConfigText(JSON.stringify(defaultConfigFor(kind), null, 2));
  }, [kind, isEdit]);

  const parsedSchema = useMemo(() => safeJson(schemaText), [schemaText]);
  const parsedConfig = useMemo(() => safeJson(configText), [configText]);
  const parsedTestArgs = useMemo(() => safeJson(testArgsText), [testArgsText]);

  const canSave =
    !!name.trim() &&
    !!description.trim() &&
    parsedSchema.ok &&
    parsedConfig.ok &&
    !saving;

  const handleSave = () => {
    if (!canSave) return;
    const body: CustomToolPayload = {
      name: name.trim(),
      description: description.trim(),
      input_schema:
        (parsedSchema.value as Record<string, unknown>) ?? DEFAULT_SCHEMA,
      backend_kind: kind,
      config: (parsedConfig.value as Record<string, unknown>) ?? {},
      enabled,
    };
    onSubmit({ id: editing?.id, body });
  };

  const handleTest = async () => {
    if (!editing) return;
    if (!parsedTestArgs.ok) return;
    setTestRunning(true);
    setTestResult(null);
    try {
      const res = await customToolsApi.test(
        editing.id,
        (parsedTestArgs.value as Record<string, unknown>) ?? {},
        testDryRun,
      );
      setTestResult(res);
    } catch (e) {
      setTestResult({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setTestRunning(false);
    }
  };

  const KindIcon = KIND_ICONS[kind];

  return (
    <RegistryFormShell
      icon={Wrench}
      title={isEdit ? `${editing.name} 편집` : '새 커스텀 도구'}
      subtitle={
        isEdit
          ? 'name 이외의 모든 필드 편집 가능. is_sample 은 불변.'
          : 'name · description · input_schema · backend 를 채우고 저장하면 즉시 ToolLoader 에 반영됩니다.'
      }
      backLabel="목록으로"
      onBack={onClose}
      error={error}
      onDismissError={() => {}}
      footer={
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded-md border border-[hsl(var(--border))] hover:bg-[hsl(var(--accent))]"
          >
            취소
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            className={[
              'inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md text-white',
              canSave
                ? 'bg-[hsl(var(--primary))] hover:opacity-90'
                : 'bg-[hsl(var(--muted))] cursor-not-allowed',
            ].join(' ')}
          >
            <Save className="w-3.5 h-3.5" />
            {saving ? '저장 중…' : isEdit ? '변경 저장' : '도구 만들기'}
          </button>
        </div>
      }
    >
      {/* 1. 기본 정보 */}
      <Section
        title="1. 기본 정보"
        subtitle="LLM 에 보이는 도구의 이름·설명과 입력 JSON Schema. session_id 같은 호스트 주입 인자는 자동 제거됩니다."
      >
        <Field label="이름 (LLM-facing)">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase())}
            placeholder="my_custom_tool"
            disabled={isEdit}
            className="font-mono text-sm"
          />
          {isEdit ? (
            <Hint>편집 모드에서는 name 변경 불가. 새 이름이 필요하면 복제(Copy) 후 편집.</Hint>
          ) : (
            <Hint>lowercase + snake_case. 다른 도구와 충돌 시 409.</Hint>
          )}
        </Field>
        <Field label="설명 (LLM-facing)">
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="이 도구가 무엇을 하는지 LLM이 이해할 수 있도록 한 단락으로 작성"
            rows={4}
            className="text-sm"
          />
        </Field>
        <Field label="활성화">
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            ToolLoader 에 노출
          </label>
        </Field>
        <Field
          label="input_schema (JSON Schema)"
          right={<ParseChip ok={parsedSchema.ok} error={parsedSchema.error} />}
        >
          <Textarea
            value={schemaText}
            onChange={(e) => setSchemaText(e.target.value)}
            rows={10}
            className="text-xs font-mono"
          />
          <Hint>
            추가 필드는 자동으로 거부됩니다 (additionalProperties=false). session_id 등 호스트 주입 인자는 저장 시 자동 제거됩니다.
          </Hint>
        </Field>
      </Section>

      {/* 2. 백엔드 */}
      <Section
        title="2. 백엔드 설정"
        subtitle={KIND_HINTS[kind]}
      >
        <Field label="백엔드 종류">
          <div className="flex flex-wrap gap-2">
            {/* When editing an existing builtin_alias row we keep the
                picker showing it so the operator can see + change it;
                for new tools we hide it (legacy kind — use python_inline). */}
            {(isEdit && editing?.backend_kind === 'builtin_alias'
              ? ([...NEW_TOOL_KINDS, 'builtin_alias'] as CustomToolBackendKind[])
              : NEW_TOOL_KINDS
            ).map((k) => {
              const Icon = KIND_ICONS[k];
              const active = k === kind;
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  className={[
                    'flex-1 min-w-[120px] inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-sm border',
                    active
                      ? 'border-[hsl(var(--primary))] bg-[hsl(var(--primary)/0.06)] text-[hsl(var(--primary))]'
                      : 'border-[hsl(var(--border))] text-[hsl(var(--foreground))] hover:bg-[hsl(var(--accent))]',
                  ].join(' ')}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {KIND_LABELS[k]}
                </button>
              );
            })}
          </div>
        </Field>

        {kind === 'python_inline' ? (
          <PythonInlineEditor
            configText={configText}
            setConfigText={setConfigText}
            parsedConfig={parsedConfig}
          />
        ) : (
          <Field
            label="config (JSON)"
            right={<ParseChip ok={parsedConfig.ok} error={parsedConfig.error} />}
          >
            <Textarea
              value={configText}
              onChange={(e) => setConfigText(e.target.value)}
              rows={12}
              className="text-xs font-mono"
            />
            {kind === 'http' && (
              <Hint>
                ${'{arg:foo}'} → LLM 인자 / ${'{secret:KEY}'} → 호스트 env or settings / ${'{session:session_id}'} → 트러스티드 컨텍스트. method · url_template · headers · body_template · timeout_seconds · response_handler 지원.
              </Hint>
            )}
            {kind === 'mcp_proxy' && (
              <Hint>
                upstream_mcp_server (등록된 MCP 서버 이름) + upstream_tool_name 필수. schema_overlay 로 부분 스키마 덮어쓰기 가능.
              </Hint>
            )}
            {kind === 'builtin_alias' && (
              <Hint>
                (legacy) source_module = `blog_agent_tools` 같은 *_tools.py 의 stem. 신규 도구는 python_inline 으로 작성 권장.
              </Hint>
            )}
          </Field>
        )}
      </Section>

      {/* 3. 테스트 */}
      <Section
        title="3. 테스트"
        subtitle="dry-run 은 인자 검증만 수행. real-call 은 실제 외부 호출."
      >
        {!isEdit ? (
          <Hint>도구를 먼저 저장한 뒤 테스트할 수 있습니다.</Hint>
        ) : (
          <>
            <Field
              label="arguments (JSON)"
              right={
                <ParseChip ok={parsedTestArgs.ok} error={parsedTestArgs.error} />
              }
            >
              <Textarea
                value={testArgsText}
                onChange={(e) => setTestArgsText(e.target.value)}
                rows={6}
                className="text-xs font-mono"
              />
            </Field>
            <Field label="실행 모드">
              <label className="inline-flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={testDryRun}
                  onChange={(e) => setTestDryRun(e.target.checked)}
                />
                dry-run (스키마 검증만)
              </label>
            </Field>
            <button
              type="button"
              onClick={handleTest}
              disabled={!parsedTestArgs.ok || testRunning}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border border-[hsl(var(--border))] hover:bg-[hsl(var(--accent))] disabled:opacity-50"
            >
              {testRunning ? (
                <Box className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Play className="w-3.5 h-3.5" />
              )}
              {testRunning ? '실행 중…' : testDryRun ? 'Dry-run' : 'Real-call'}
            </button>
            {testResult && (
              <div
                className={[
                  'mt-3 rounded-md border p-3 text-xs',
                  testResult.ok
                    ? 'border-[hsl(var(--good)/0.4)] bg-[hsl(var(--good)/0.06)]'
                    : 'border-[hsl(var(--destructive)/0.4)] bg-[hsl(var(--destructive)/0.06)]',
                ].join(' ')}
              >
                <div className="flex items-center gap-2 mb-1.5">
                  {testResult.ok ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-[hsl(var(--good))]" />
                  ) : (
                    <XCircle className="w-3.5 h-3.5 text-[hsl(var(--destructive))]" />
                  )}
                  <span className="font-medium">
                    {testResult.ok ? '성공' : '실패'}
                  </span>
                  {testResult.duration_ms != null && (
                    <span className="text-[hsl(var(--muted-foreground))]">
                      ({testResult.duration_ms} ms)
                    </span>
                  )}
                </div>
                <pre className="whitespace-pre-wrap break-words font-mono">
                  {testResult.error ?? testResult.result ?? '(no body)'}
                </pre>
              </div>
            )}
          </>
        )}
      </Section>
    </RegistryFormShell>
  );
}

// ── helpers ─────────────────────────────────────────────────────

function safeJson(text: string): {
  ok: boolean;
  value: unknown;
  error?: string;
} {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return {
      ok: false,
      value: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section className="border border-[hsl(var(--border))] rounded-lg overflow-hidden bg-[hsl(var(--card))]">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-[hsl(var(--accent))]"
      >
        <div>
          <div className="text-sm font-semibold">{title}</div>
          {subtitle && (
            <div className="text-xs text-[hsl(var(--muted-foreground))] mt-0.5">
              {subtitle}
            </div>
          )}
        </div>
        {open ? (
          <ArrowUp className="w-3.5 h-3.5 text-[hsl(var(--muted-foreground))]" />
        ) : (
          <ArrowDown className="w-3.5 h-3.5 text-[hsl(var(--muted-foreground))]" />
        )}
      </button>
      {open && <div className="px-4 py-3 space-y-3 border-t border-[hsl(var(--border))]">{children}</div>}
    </section>
  );
}

function Field({
  label,
  right,
  children,
}: {
  label: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-xs font-medium text-[hsl(var(--muted-foreground))]">
          {label}
        </label>
        {right}
      </div>
      {children}
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] text-[hsl(var(--muted-foreground))] mt-1.5 leading-snug">
      {children}
    </p>
  );
}

function ParseChip({ ok, error }: { ok: boolean; error?: string }) {
  return (
    <span
      className={[
        'inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-mono',
        ok
          ? 'text-[hsl(var(--good))] bg-[hsl(var(--good)/0.08)]'
          : 'text-[hsl(var(--destructive))] bg-[hsl(var(--destructive)/0.08)]',
      ].join(' ')}
      title={error}
    >
      {ok ? <CheckCircle2 className="w-2.5 h-2.5" /> : <XCircle className="w-2.5 h-2.5" />}
      {ok ? 'JSON OK' : 'JSON 오류'}
    </span>
  );
}

/**
 * PythonInlineEditor — split editor for the python_inline backend.
 *
 * The DB-side ``config`` is a single ``PythonInlineConfig`` blob
 * (``source_code`` + ``class_name``). For ergonomics, we split it into
 * a tall code textarea and a small class-name input — and serialise
 * back to the same JSON the other backends use, so the parent's
 * ``parsedConfig`` chip + save path don't care which kind we're in.
 */
function PythonInlineEditor({
  configText,
  setConfigText,
  parsedConfig,
}: {
  configText: string;
  setConfigText: (text: string) => void;
  parsedConfig: { ok: boolean; value: unknown; error?: string };
}) {
  const obj =
    parsedConfig.ok && parsedConfig.value && typeof parsedConfig.value === 'object'
      ? (parsedConfig.value as Record<string, unknown>)
      : null;
  const sourceCode =
    obj && typeof obj.source_code === 'string' ? obj.source_code : '';
  const className =
    obj && typeof obj.class_name === 'string' ? obj.class_name : '';

  const update = (next: { source_code?: string; class_name?: string }) => {
    const merged = {
      source_code: next.source_code ?? sourceCode,
      class_name: next.class_name ?? className,
    };
    setConfigText(JSON.stringify(merged, null, 2));
  };

  return (
    <div className="space-y-3">
      <Field
        label="class_name"
        right={<ParseChip ok={parsedConfig.ok} error={parsedConfig.error} />}
      >
        <Input
          value={className}
          onChange={(e) => update({ class_name: e.target.value })}
          placeholder="MyCustomTool"
          className="font-mono text-sm"
        />
        <Hint>
          source_code 안에서 instantiate 할 BaseTool 서브클래스 이름. 같은 파일에 helper class 가 여러 개 있어도 됨.
        </Hint>
      </Field>
      <Field label="source_code (Python)">
        <Textarea
          value={sourceCode}
          onChange={(e) => update({ source_code: e.target.value })}
          rows={24}
          className="text-xs font-mono"
          spellCheck={false}
          wrap="off"
        />
        <Hint>
          BaseTool 서브클래스를 정의. <code>BaseTool</code>, <code>ToolError</code>, <code>asyncio</code>, <code>json</code>, <code>logging</code>, <code>typing</code> 은 네임스페이스에 자동 주입. <code>service.*</code>, <code>geny_executor.*</code> 등은 일반 import 로 접근. host-admin 권한으로 실행됨 — 외부 사용자에 admin 권한 주지 말 것.
        </Hint>
      </Field>
    </div>
  );
}
