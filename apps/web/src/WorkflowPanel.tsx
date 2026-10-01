import { useEffect, useState } from 'react';
import {
  fetchWorkflowJob,
  fetchWorkflowSource,
  fetchWorkflows,
  runWorkflow,
  saveWorkflowSource,
  type WorkflowJob,
  type WorkflowSummary,
} from './api';

interface Props {
  onNotice(message: string): void;
  onVideosChanged(): void;
  /** 本机没显卡档时为真:只有吃显卡的工作流(步骤里有本地出片)不显示「运行」 */
  localDisabled?: boolean;
}

function jobText(job: WorkflowJob | null): string {
  if (!job || job.state === 'idle') return '';
  if (job.state === 'running') {
    const running = job.steps.find((s) => s.state === 'running');
    return running ? `正在运行:${running.id}(${running.tool})` : '正在运行工作流…';
  }
  if (job.state === 'done') return '工作流完成,成片已放进作品库。';
  return `工作流失败:${job.error}`;
}

export function WorkflowPanel({ onNotice, onVideosChanged, localDisabled = false }: Props) {
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [topic, setTopic] = useState('橘猫在书桌边做晚间创作');
  const [source, setSource] = useState('');
  const [job, setJob] = useState<WorkflowJob | null>(null);
  const [running, setRunning] = useState(false);

  const refresh = () => fetchWorkflows().then(setWorkflows);
  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (!selected) return;
    fetchWorkflowSource(selected).then((s) => setSource(s ?? ''));
  }, [selected]);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(async () => {
      const j = await fetchWorkflowJob();
      setJob(j);
      if (j?.state === 'done' || j?.state === 'error') {
        setRunning(false);
        onVideosChanged();
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [running, onVideosChanged]);

  async function run(id: string) {
    const text = topic.trim();
    if (!text) return onNotice('先填一句主题。');
    const result = await runWorkflow(id, text);
    if (!result.ok) return onNotice(result.message);
    setJob(result.job);
    setRunning(true);
  }

  async function save() {
    if (!selected) return;
    const result = await saveWorkflowSource(selected, source);
    if (result.ok) {
      onNotice('工作流已保存。');
      refresh();
    } else onNotice(result.message);
  }

  return (
    <section className="workflows" data-testid="workflow-library" aria-label="工作流库">
      <h2>工作流库</h2>
      <label className="workflow-topic">
        一句主题
        <input value={topic} onChange={(e) => setTopic(e.target.value)} aria-label="工作流主题" />
      </label>
      <div className="workflow-list">
        {workflows.map((w) => (
          <article key={w.id} className="workflow-card" data-testid={`workflow-${w.id}`}>
            <div>
              <strong>{w.title}</strong> {w.builtin && <span className="badge">内置</span>}
              <p>{w.description}</p>
              <small>{w.steps} 步</small>
            </div>
            <div className="workflow-actions">
              {localDisabled && w.needsLocalGpu ? (
                <span className="notice" data-testid="workflow-local-disabled">
                  要本机显卡出片,这台机器跑不动 —— 在下面聊天框说一句,走云端
                </span>
              ) : (
                <button type="button" data-testid={`workflow-run-${w.id}`} onClick={() => run(w.id)} disabled={running}>
                  运行
                </button>
              )}
              <button type="button" onClick={() => setSelected(w.id)}>
                看原文
              </button>
            </div>
          </article>
        ))}
      </div>
      {job && <p className="notice" data-testid="workflow-job">{jobText(job)}</p>}
      {selected && (
        <div className="workflow-source">
          <h3>SKILL.md 原文:{selected}</h3>
          <textarea aria-label="SKILL.md 原文" value={source} onChange={(e) => setSource(e.target.value)} />
          <button type="button" onClick={save}>
            保存原文
          </button>
        </div>
      )}
    </section>
  );
}
