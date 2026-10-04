<template>
  <section class="page" data-module="supply">
    <header class="page-head">
      <div>
        <h2>物资储备管理</h2>
        <p class="page-desc">
          按物资类别比较预警储备量与实际储备量，并结合林场需求动态判定：达到基准线（预警/需求较大值）为充足，80%-100% 偏低，不足 80% 需补充。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出物资储备清单</button>
      </div>
    </header>

    <p v-if="!store.isKeeperFarm" class="readonly-banner">
      当前「{{ store.currentFarm }}」为非保管林场，只能查看物资储备信息，盘点、补充与调拨操作已禁用。
    </p>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>生效预警</th>
          <th>系统建议</th>
          <th>当前状态</th>
          <th>可用量</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ formatCell(row, column) }}</td>
          <td>
            {{ row._eval.warn }}
            <span v-if="row._eval.warnFallback" class="fallback-tag" title="历史缺少预警储备量，按同类物资中位数兼容">中位数兼容</span>
          </td>
          <td>
            <span class="badge" :class="badgeClass(row._eval.suggestion)">{{ row._eval.suggestion }}</span>
            <span class="fallback-tag">基准 {{ row._eval.baseline }} · {{ Math.round(row._eval.ratio * 100) }}%</span>
          </td>
          <td :class="{ 'conflict-cell': row._manualOverride }">
            {{ row.status }}
            <span v-if="row._manualOverride" class="badge badge-warn" :title="String(row['盘点备注'] ?? '')">人工覆盖</span>
          </td>
          <td>
            <span :class="row._available > 0 ? 'qty-ok' : 'qty-zero'">{{ row._available }}</span>
          </td>
          <td class="row-actions">
            <button class="link" type="button" :disabled="!canOperate(row)" @click="openStocktake(row)">人工盘点</button>
            <button class="link" type="button" :disabled="!canOperate(row)" @click="doAction('发起补充', row)">发起补充</button>
            <button class="link" type="button" :disabled="!canOperate(row) || row.status === '已过期'" @click="doAction('确认补充', row)">确认补充</button>
            <button class="link" type="button" :disabled="!canOperate(row) || row.status === '已过期' || row._available <= 0" @click="openTransfer(row)">调拨出库</button>
            <button class="link" type="button" :disabled="!canOperate(row)" @click="doAction('标记过期', row)">标记过期</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 5" class="empty-state">暂无物资储备数据</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条物资储备记录 · 判定口径统一，数量超出 0-9999 不允许保存</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="successMessage" class="qty-ok">{{ successMessage }}</span>
    </footer>

    <TeamRequisitionPanel />
    <StocktakeHistoryPanel />

    <!-- 人工盘点弹窗：盘点结论可人工指定，与系统建议冲突时人工优先 -->
    <div v-if="stocktakeForm" class="modal-mask" @click.self="closeStocktake">
      <div class="modal">
        <h3>人工盘点 · {{ stocktakeForm.name }}（{{ stocktakeForm.code }}）</h3>
        <div class="form-grid">
          <p class="form-hint">
            储备林场：{{ stocktakeForm.farm }} ｜ 系统建议：<span class="badge" :class="badgeClass(stocktakeForm.suggestion)">{{ stocktakeForm.suggestion }}</span>
            ｜ 生效预警：{{ stocktakeForm.warn }} ｜ 林场需求：{{ stocktakeForm.demand }} ｜ 缺口：{{ stocktakeForm.gap }}
          </p>
          <label>
            <span>盘点实际储备量（0-9999 整数）</span>
            <input v-model="stocktakeForm.actual" placeholder="请录入人工盘点数量" />
          </label>
          <label>
            <span>人工盘点结论</span>
            <select v-model="stocktakeForm.manualConclusion">
              <option value="">按系统建议自动判定</option>
              <option v-for="status in manualStatuses" :key="status" :value="status">{{ status }}</option>
            </select>
          </label>
          <p class="form-hint">规则：人工盘点与系统建议冲突时，以人工盘点结论为准，系统建议留痕并标记「人工覆盖」。</p>
        </div>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeStocktake">取消</button>
          <button class="btn primary" type="button" @click="submitStocktake">保存盘点</button>
        </div>
      </div>
    </div>

    <!-- 人工调拨弹窗：每次打开生成新提交键，重复点确认只扣一次 -->
    <div v-if="transferForm" class="modal-mask" @click.self="closeTransfer">
      <div class="modal">
        <h3>调拨出库 · {{ transferForm.name }}（{{ transferForm.code }}）</h3>
        <div class="form-grid">
          <p class="form-hint">储备林场：{{ transferForm.farm }} ｜ 当前可用量：{{ transferForm.available }}</p>
          <label>
            <span>领用扑火队伍</span>
            <select v-model="transferForm.teamId">
              <option :value="0" disabled>请选择队伍</option>
              <option v-for="team in teams" :key="team.id" :value="team.id">{{ team.name }}（{{ team.farm }} · {{ team.status }}）</option>
            </select>
          </label>
          <label>
            <span>调拨数量（0-{{ transferForm.available }}）</span>
            <input v-model="transferForm.qty" placeholder="请输入调拨数量" />
          </label>
          <p class="form-hint">提交后写入队伍领用清单并重算可用量；同一调拨单重复提交只扣减一次。</p>
        </div>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeTransfer">取消</button>
          <button class="btn primary" type="button" @click="submitTransfer">确认调拨</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import {
  applyStocktake,
  buildSupplyViewRows,
  confirmReplenish,
  requestReplenish,
  teamOptions,
  transferSupply,
  type SupplyViewRow,
  type TeamOption,
} from '@/api/supply-chain'
import { downloadEntries, listEntries, moduleMeta, runAction as runActionAlias } from '@/api/local-service'
import { listStocktakes } from '@/data/ledger-store'
import type { StocktakeRecord } from '@/data/types'
import { useSessionStore } from '@/stores/session'
import TeamRequisitionPanel from '@/components/TeamRequisitionPanel.vue'
import { SUPPLY_ACTUAL_FIELD, SUPPLY_CATEGORY_FIELD, SUPPLY_FARM_FIELD, SUPPLY_WARN_FIELD } from '@/data/supply-rule'

// 盘点历史以行内子组件方式呈现，单独定义避免主模板过长。
import { defineComponent, h } from 'vue'
const StocktakeHistoryPanel = defineComponent({
  setup() {
    const records = ref<StocktakeRecord[]>(listStocktakes())
    const reload = () => {
      records.value = listStocktakes()
    }
    onMounted(() => window.addEventListener('forest-ledger-changed', reload))
    onBeforeUnmount(() => window.removeEventListener('forest-ledger-changed', reload))
    return () =>
      h('section', { class: 'sub-panel' }, [
        h('header', { class: 'sub-panel-head' }, [
          h('h3', `人工盘点留痕（${records.value.length}）`),
          h('span', { class: 'sub-panel-tip' }, '冲突时人工结论优先，系统建议保留备查'),
        ]),
        h('table', { class: 'data-table sub-table' }, [
          h('thead', null, h('tr', null, ['日期', '物资', '林场', '盘点人', '盘点前', '盘点后', '系统建议', '人工结论', '是否冲突'].map((t) => h('th', t)))),
          h(
            'tbody',
            records.value.length
              ? records.value.map((r) =>
                  h('tr', { key: r.id }, [
                    h('td', r.createdAt),
                    h('td', `${r.supplyCode}`),
                    h('td', r.farm),
                    h('td', r.operator),
                    h('td', String(r.beforeActual)),
                    h('td', String(r.afterActual)),
                    h('td', r.systemSuggest),
                    h('td', { class: r.conflict ? 'conflict-cell' : '' }, r.manualConclusion),
                    h('td', r.conflict ? '是（人工优先）' : '否'),
                  ]),
                )
              : [h('tr', null, h('td', { colspan: 9, class: 'empty-state' }, '暂无盘点记录'))],
          ),
        ]),
      ])
  },
})

const store = useSessionStore()
const meta = moduleMeta('supply')
const columns = ['物资编号', '物资名称', '物资类别', '规格型号', '储备林场', '林场需求', '预警储备量', '实际储备量', '物资状态']
const statuses = ['充足', '偏低', '需补充', '已过期']
const manualStatuses = ['充足', '偏低', '需补充']

const rows = ref<SupplyViewRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const successMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ['物资编号', '物资名称', SUPPLY_CATEGORY_FIELD, SUPPLY_FARM_FIELD]
const teams = ref<TeamOption[]>([])

const stats = computed(() => {
  const list = rows.value
  return [
    { label: '物资种类', value: list.length },
    { label: '偏低种类', value: list.filter((r) => r._eval.suggestion === '偏低').length },
    { label: '需补充种类', value: list.filter((r) => r._eval.suggestion === '需补充').length },
    { label: '过期种类', value: list.filter((r) => r.status === '已过期').length },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

type StocktakeForm = {
  id: number
  code: string
  name: string
  farm: string
  actual: string
  manualConclusion: string
  suggestion: string
  warn: number
  demand: number
  gap: number
}

const stocktakeForm = ref<StocktakeForm | null>(null)

type TransferForm = {
  id: number
  code: string
  name: string
  farm: string
  available: number
  teamId: number
  qty: string
  idemKey: string
}

const transferForm = ref<TransferForm | null>(null)

function canOperate(row: SupplyViewRow): boolean {
  return store.isKeeperOf(String(row[SUPPLY_FARM_FIELD] ?? ''))
}

function badgeClass(status: string): string {
  if (status === '充足') return 'badge-ok'
  if (status === '偏低') return 'badge-warn'
  if (status === '需补充') return 'badge-bad'
  return 'badge-exp'
}

function formatCell(row: SupplyViewRow, column: string): unknown {
  if (column === SUPPLY_WARN_FIELD) {
    const raw = String(row[SUPPLY_WARN_FIELD] ?? '')
    return raw === '' ? '—（按同类中位数兼容）' : raw
  }
  return row[column] ?? '—'
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function flash(message: string, ok: boolean) {
  errorMessage.value = ok ? '' : message
  successMessage.value = ok ? message : ''
}

function doAction(action: string, row: SupplyViewRow) {
  if (action === '发起补充') {
    const result = requestReplenish(Number(row.id), store.currentFarm)
    flash(result.message, result.ok)
    reload()
    return
  }
  if (action === '确认补充') {
    const result = confirmReplenish(Number(row.id), store.currentFarm)
    flash(result.message, result.ok)
    reload()
    return
  }
  const result = runActionAlias(meta.key, Number(row.id), action)
  flash(result.message, result.ok)
  reload()
}

function openStocktake(row: SupplyViewRow) {
  stocktakeForm.value = {
    id: Number(row.id),
    code: String(row['物资编号'] ?? ''),
    name: String(row['物资名称'] ?? ''),
    farm: String(row[SUPPLY_FARM_FIELD] ?? ''),
    actual: String(row[SUPPLY_ACTUAL_FIELD] ?? ''),
    manualConclusion: '',
    suggestion: row._eval.suggestion,
    warn: row._eval.warn,
    demand: row._eval.demand,
    gap: row._eval.gap,
  }
}

function closeStocktake() {
  stocktakeForm.value = null
}

function submitStocktake() {
  if (!stocktakeForm.value) return
  const result = applyStocktake({
    id: stocktakeForm.value.id,
    actual: stocktakeForm.value.actual,
    manualConclusion: stocktakeForm.value.manualConclusion,
    operatorFarm: store.currentFarm,
    operator: store.operator,
  })
  flash(result.message, result.ok)
  if (result.ok) {
    closeStocktake()
  }
  reload()
}

function openTransfer(row: SupplyViewRow) {
  transferForm.value = {
    id: Number(row.id),
    code: String(row['物资编号'] ?? ''),
    name: String(row['物资名称'] ?? ''),
    farm: String(row[SUPPLY_FARM_FIELD] ?? ''),
    available: row._available,
    teamId: teams.value.find((team) => team.farm === String(row[SUPPLY_FARM_FIELD] ?? ''))?.id ?? 0,
    qty: '',
    idemKey: `manual-transfer-${Number(row.id)}-${Date.now()}`,
  }
}

function closeTransfer() {
  transferForm.value = null
}

function submitTransfer() {
  if (!transferForm.value) return
  const result = transferSupply({
    supplyId: transferForm.value.id,
    teamId: transferForm.value.teamId,
    qty: transferForm.value.qty,
    idemKey: transferForm.value.idemKey,
    operatorFarm: store.currentFarm,
  })
  flash(result.message, result.ok)
  if (result.ok) {
    closeTransfer()
  }
  reload()
}

function reload() {
  const payload = listEntries(meta.key, filters.value)
  rows.value = buildSupplyViewRows(payload.items)
  total.value = payload.total
  teams.value = teamOptions()
}

function onLedgerChanged() {
  reload()
}

onMounted(() => {
  reload()
  window.addEventListener('forest-ledger-changed', onLedgerChanged)
})

onBeforeUnmount(() => {
  window.removeEventListener('forest-ledger-changed', onLedgerChanged)
})
</script>
