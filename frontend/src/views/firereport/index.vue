<template>
  <section class="page" data-module="firereport">
    <header class="page-head">
      <div>
        <h2>火情报告管理（处置联动物资调拨）</h2>
        <p class="page-desc">
          「出动扑救」按火势等级向处置林场一次性调拨物资并扣减实际储备，物资状态与队伍领用清单同步重算；
          同一火情重复出动只扣一次，库存不足整笔不保存。当前林场：<strong>{{ session.currentFarm }}</strong>
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记火情报告</button>
        <button class="btn" type="button" @click="exportRows">导出火情报告清单</button>
      </div>
    </header>

    <p v-if="dispatchMessage" class="dispatch-banner" :class="dispatchOk ? 'ok' : 'err'">{{ dispatchMessage }}</p>

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
          <th>当前状态</th>
          <th>调拨情况</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td>{{ dispatchState(row) }}</td>
          <td class="row-actions">
            <template v-for="action in actions" :key="action">
              <button
                v-if="action === '出动扑救'"
                class="link"
                type="button"
                :disabled="!canDispatch(row)"
                @click="dispatch(row)"
              >
                {{ action }}
              </button>
              <button v-else class="link" type="button" @click="runAction(action, row)">{{ action }}</button>
            </template>
            <span v-if="!canDispatch(row) && row.status === '已确认'" class="sub-text">非处置林场，仅可查看</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无火情报告数据，可先登记火情报告</td>
        </tr>
      </tbody>
    </table>

    <section class="link-panel">
      <header class="link-head">
        <h3>火情处置调拨台账</h3>
        <span class="sub-text">来源=火情处置的出库记录，与物资页台账同源同口径。</span>
      </header>
      <table class="data-table">
        <thead>
          <tr>
            <th>时间</th>
            <th>处置林场</th>
            <th>物资</th>
            <th>调拨数量</th>
            <th>关联火情</th>
            <th>操作人</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="entry in fireLedger" :key="entry.id">
            <td>{{ entry.time }}</td>
            <td>{{ entry.farm }}</td>
            <td>{{ entry.supplyId > 0 ? entry.supplyName : '调拨单确认' }}</td>
            <td class="num-zero">{{ entry.quantity }}</td>
            <td>{{ entry.ref }}</td>
            <td>{{ entry.operator }}</td>
          </tr>
          <tr v-if="!fireLedger.length">
            <td colspan="6" class="empty-state">尚无火情处置调拨记录</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条火情报告记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'
import { useReserveStore } from '@/stores/reserve'
import { useSessionStore } from '@/stores/session'

const meta = moduleMeta('firereport')
const columns = ["报告编号", "起火地点", "起火时间", "火势等级", "过火面积", "扑救情况", "报告人", "处置林场"]
const actions = ["核实火情", "出动扑救", "确认误报"]
const statuses = ["待核实", "已确认", "已出警", "已扑灭", "误报"]

const reserve = useReserveStore()
const session = useSessionStore()

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const dispatchMessage = ref('')
const dispatchOk = ref(false)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const stats = computed(() => [
  { label: '今日报告数', value: rows.value.length },
  { label: '已确认火情', value: rows.value.filter((row) => ['已确认', '已出警', '已扑灭'].includes(String(row.status))).length },
  { label: '扑救中火情', value: rows.value.filter((row) => ['已出警', '扑救中'].includes(String(row.status))).length },
])

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const fireLedger = computed(() => reserve.ledger.filter((entry) => entry.source === '火情处置'))

function dispatchKey(row: EntryRow): string {
  return `火情调拨:${Number(row.id)}`
}
function isDispatched(row: EntryRow): boolean {
  return reserve.hasLedgerKey(dispatchKey(row))
}
function dispatchState(row: EntryRow): string {
  if (isDispatched(row)) {
    const count = reserve.ledger.filter(
      (entry) => entry.source === '火情处置' && entry.ref === `火情${String(row['报告编号'])}` && entry.supplyId > 0,
    ).length
    return `已调拨 ${count} 项`
  }
  if (String(row.status) === '已确认') {
    return '待调拨'
  }
  return '—'
}
function canDispatch(row: EntryRow): boolean {
  return (
    String(row.status) === '已确认' &&
    !isDispatched(row) &&
    session.isKeeperOf(String(row['处置林场'] ?? ''))
  )
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '火情报告登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function dispatch(row: EntryRow) {
  errorMessage.value = ''
  dispatchMessage.value = ''
  const result = reserve.dispatchFire({
    fireId: Number(row.id),
    level: String(row['火势等级'] ?? ''),
    farm: String(row['处置林场'] ?? ''),
    reportNo: String(row['报告编号'] ?? row.id),
  })
  dispatchOk.value = result.ok
  if (result.ok) {
    // 物资状态 → 火情处置调拨链路：状态推进到已出警
    applyAction(meta.key, Number(row.id), '出动扑救')
  }
  dispatchMessage.value = result.message
  reload()
}

function reload() {
  reserve.init()
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '火情报告列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.sub-text {
  font-size: 12px;
  color: var(--muted);
}
.link[disabled] {
  color: #94a3b8;
  cursor: not-allowed;
}
.dispatch-banner {
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 13px;
}
.dispatch-banner.ok {
  background: #dcfce7;
  border: 1px solid #86efac;
  color: #15803d;
}
.dispatch-banner.err {
  background: #fee2e2;
  border: 1px solid #fca5a5;
  color: #b42318;
}
.num-zero {
  color: #b42318;
}
.link-panel {
  margin-top: 16px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
}
.link-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 8px;
}
.link-head h3 {
  margin: 0;
  font-size: 14px;
}
</style>
