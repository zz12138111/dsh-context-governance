/**
 * dsh-context-governance · 浏览器半侧（1.1.0 D2）
 *
 * 格式：手写 `window.__ModuleLoader__.load({ id, factory })`（与宿主已装插件 cost-meter / dsh-context 同形；
 * 本仓不引打包器，此文件即产物，审核按本注释与文件本体核对）。
 * id：`dsh-context-governance`（= 宿主 settings 命名空间 = Cordis 条目 id，见 cordis.patch.yml）。
 *
 * 依赖的共享模块（由 factory 的 require 形参从宿主模块表解析，不随包发布）：
 *   - `react`                       仅用于创建组件元素
 * 注入的客户端服务（`inject`）：
 *   - `slots`      向宿主 `settings.section` 槽位注册卡片
 *   - `configForms` 读写当前 profile 条目 `dsh-context-governance` 的形态表单（写 → profile Cordis patch）
 *   - `locale`     卡片双语标签
 * 数据来源：同源 `GET /context-governance/policy-snapshot`（宿主侧只读路由）。
 * 安全边界：只暴露 `compact.at`（百分比 0–100，内部 /100）；estimateSafety/lowThresholdAck/armed 无入口。
 */
window.__ModuleLoader__.load({
  id: 'dsh-context-governance',
  factory: (require) => {
    const react = require('react');

    const ENTRY_ID = 'dsh-context-governance';
    const SNAPSHOT_PATH = '/context-governance/policy-snapshot';
    const AT_MIN = 0.2;
    const LOW_THRESHOLD_ACK_MIN = 0.3;
    const LABELS = {
      zh: { sectionLabel: '上下文治理', title: '压缩触发阈值', percent: '触发百分比（0–100）', save: '保存', reset: '恢复默认', effective: '当前生效', source: '来源层', when: '生效时点', invalid: '输入无效' },
      en: { sectionLabel: 'Context governance', title: 'Compaction threshold', percent: 'Trigger percent (0–100)', save: 'Save', reset: 'Reset', effective: 'Effective', source: 'Source layer', when: 'Takes effect', invalid: 'Invalid input' },
    };

    /** 比例 → 百分比文本；非数字 → '—'（C11 三态渲染共用）。 */
    const toPercentText = (at) => (Number.isFinite(at) ? `${Math.round(Number(at) * 100)}%` : '—');

    /** 百分比输入 → 比例（0–1，两位小数）；非法 → null。 */
    const toRatio = (raw) => {
      const value = Number(String(raw ?? '').trim());
      if (!Number.isFinite(value) || value < 0 || value > 100) return null;
      return Math.round(value) / 100;
    };

    /**
     * 校验（与 /cg set 同一套规则；返回 null 表示通过，否则返回原因文本）。
     * 规则：0.20 下限；<0.30 需配置 lowThresholdAck=true（UI 无入口，故拒绝并给出与 /cg set 一致的原因）；
     * 上限由宿主窗口动态决定（非 1.0），这里只拒绝 >100%。
     */
    const validateRatio = (ratio, { projectLayer = false } = {}) => {
      if (ratio === null) return '请输入 0–100 的百分比';
      const min = projectLayer ? 0.45 : AT_MIN;
      if (ratio < min) return `compact.at 下限 ${min}`;
      if (ratio < LOW_THRESHOLD_ACK_MIN) return 'compact.at<0.30 需 compact.lowThresholdAck=true';
      if (ratio > 100 / 100) return 'compact.at 上限 100%';
      return null;
    };

    /** 渲染文本（纯函数，C11 测试直接调用）：生效值 + 来源层 + 生效时点。 */
    const renderPolicyText = (snapshot = {}, labels = LABELS.zh) => {
      const line1 = `${labels.effective}: ${toPercentText(snapshot.at)}`;
      const line2 = `${labels.source}: ${snapshot.source ?? 'unknown'}`;
      const line3 = `${labels.when}: ${snapshot.effectiveAt ?? ''}`;
      return [line1, line2, line3].join('\n');
    };

    /** 拉取同源快照（只读 GET）；失败返回 null。 */
    const fetchSnapshot = async (fetchImpl = globalThis.fetch) => {
      if (typeof fetchImpl !== 'function') return null;
      try {
        const response = await fetchImpl(SNAPSHOT_PATH, { method: 'GET', headers: { accept: 'application/json' } });
        if (!response || response.ok !== true) return null;
        return await response.json();
      } catch {
        return null;
      }
    };

    const h = react.createElement;

    /** 卡片组件：一个百分比输入框 + 三行信息；保存写 policy.at（profile patch）。 */
    const ContextGovernanceCard = (props) => {
      const ctx = props?.ctx ?? props;
      const labels = (ctx?.locale?.language ?? 'zh').startsWith('zh') ? LABELS.zh : LABELS.en;
      const [draft, setDraft] = react.useState('');
      const [snapshot, setSnapshot] = react.useState(null);
      const [error, setError] = react.useState('');
      react.useEffect(() => {
        let alive = true;
        fetchSnapshot(ctx?.fetch ?? globalThis.fetch).then((view) => { if (alive && view) setSnapshot(view); });
        return () => { alive = false; };
      }, [ctx]);
      const save = async () => {
        const ratio = toRatio(draft);
        const reason = validateRatio(ratio, { projectLayer: snapshot?.source === 'project' });
        if (reason !== null) { setError(reason); return; }
        try {
          const form = ctx?.configForms?.get?.(ENTRY_ID);
          if (form && typeof form.set === 'function') await form.set('policy.at', ratio);
          else if (form && typeof form.mutate === 'function') await form.mutate([{ path: 'policy.at', value: ratio }], form.revision);
          setError('');
          const next = await fetchSnapshot(ctx?.fetch ?? globalThis.fetch);
          if (next) setSnapshot(next);
        } catch (failure) {
          setError(String(failure?.message ?? failure));
        }
      };
      return h('div', { className: 'cg-settings-card' },
        h('div', { className: 'cg-settings-title' }, labels.title),
        h('label', { className: 'cg-settings-row' },
          labels.percent,
          h('input', {
            type: 'number', min: 0, max: 100, step: 1, value: draft,
            'aria-label': labels.percent,
            onChange: (event) => setDraft(event.target.value),
          }),
        ),
        h('div', { className: 'cg-settings-info' }, renderPolicyText(snapshot ?? {}, labels)),
        error === '' ? null : h('div', { className: 'cg-settings-error', role: 'alert' }, `${labels.invalid}: ${error}`),
        h('button', { type: 'button', className: 'cg-settings-save', onClick: save }, labels.save),
      );
    };

    const inject = ['slots', 'locale', 'configForms'];

    const apply = (ctx) => {
      const lang = (ctx?.locale?.language ?? 'zh').startsWith('zh') ? 'zh' : 'en';
      ctx.slots.register({
        name: 'settings.section',
        id: 'context-governance',
        order: 60,
        label: () => LABELS[lang].sectionLabel,
        inject: () => inject,
      }, ContextGovernanceCard);
    };

    return { apply, inject, ContextGovernanceCard, renderPolicyText, toPercentText, toRatio, validateRatio, fetchSnapshot };
  },
});
