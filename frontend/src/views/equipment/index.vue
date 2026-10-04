<template>
  <section class="page" data-module="equipment">
    <header class="page-head">
      <div>
        <h2>消防装备管理</h2>
        <p class="page-desc">装备按件管理，领用时选择扑火队伍并写入队伍领用清单，重复出库只扣一次；其余模块的领用清单与此同步重算可用量。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记消防装备</button>
        <button class="btn" type="button" @click="exportRows">导出消防装备清单</button>
      </div>
    </header>

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
          <th>当前可用量</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td>
            <span :class="availableMap.get(Number(row.id)) === 1 ? 'qty-ok' : 'qty-zero'">
              {{ availableMap.get(Number(row.id)) }}
            </span>
          </td>
          <td class="row-actions">
            <button class="link" type="button" :disabled="!canIssue(row)" @click="openIssue(row)">领用装备</button>
            <button class="link" type="button" @click="runAction('送检登记', row)">送检登记</button>
            <button class="link" type="button" @click="runAction('报废装备', row)">报废装备</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无消防装备数据，可先登记消防装备</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条消防装备记录 · 单件装备只能出库一次</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="successMessage" class="qty-ok">{{ successMessage }}</span>
    </footer>

    <TeamRequisitionPanel />

    <!-- 装备领用弹窗 -->
    <div v-if="issueForm" class="modal-mask" @click.self="closeIssue">
      <div class="modal">
        <h3>装备领用 · {{ issueForm.name }}（{{ issueForm.code }}）</h3>
        <div class="form-grid">
          <p class="form-hint">保管林场：{{ issueForm.farm }} · 规格：{{ issueForm.spec }}</p>
          <label>
            <span>领用扑火队伍</span>
            <select v-model="issueForm.teamId">
              <option :value="0" disabled>请选择队伍</option>
              <option v-for="team in teams" :key="team.id" :value="team.id">{{ team.name }}（{{ team.farm }} · {{ team.status }}）</option>
            </select>
          </label>
          <p class="form-hint">确认后装备置为「已领用」并写入队伍领用清单；重复领用只扣一次。</p>
        </div>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeIssue">取消</button>
          <button class="btn primary" type="button" @click="submitIssue">确认领用</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import { downloadEntries, listEntries, moduleMeta, runAction as applyAction } from '@/api/local-service'
import { availableEquipment, issueEquipment, teamOptions, type TeamOption } from '@/api/supply-chain'
import type { EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'
import TeamRequisitionPanel from '@/components/TeamRequisitionPanel.vue'

const store = useSessionStore()
const meta = moduleMeta('equipment')
const columns = ['装备编号', '装备名称', '装备类型', '规格型号', '保管林场', '购入日期', '最近检修日', '装备状态']
const statuses = ['可用', '已领用', '待检修', '已报废']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const successMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const teams = ref<TeamOption[]>([])

type IssueForm = { id: number; code: string; name: string; spec: string; farm: string; teamId: number }
const issueForm = ref<IssueForm | null>(null)

const availableMap = computed(() => {
  const map = new Map<number, number>()
  rows.value.forEach((row) => map.set(Number(row.id), availableEquipment(Number(row.id))))
  return map
})

const stats = computed(() => [
  { label: '装备总数', value: rows.value.length },
  { label: '可用装备', value: rows.value.filter((r) => String(r.status) === '可用').length },
  { label: '待检修数', value: rows.value.filter((r) => String(r.status) === '待检修').length },
  { label: '已领用', value: rows.value.filter((r) => String(r.status) === '已领用').length },
])

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function canIssue(row: EntryRow): boolean {
  return String(row.status) === '可用' && store.isKeeperOf(String(row['保管林场'] ?? ''))
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '消防装备登记入口尚未接入审批流'
  successMessage.value = ''
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  successMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) errorMessage.value = result.message
  else successMessage.value = result.message
  reload()
}

function openIssue(row: EntryRow) {
  issueForm.value = {
    id: Number(row.id),
    code: String(row['装备编号'] ?? ''),
    name: String(row['装备名称'] ?? ''),
    spec: String(row['规格型号'] ?? ''),
    farm: String(row['保管林场'] ?? ''),
    teamId: teams.value.find((team) => team.farm === String(row['保管林场'] ?? ''))?.id ?? 0,
  }
}

function closeIssue() {
  issueForm.value = null
}

function submitIssue() {
  if (!issueForm.value) return
  const result = issueEquipment({
    equipmentId: issueForm.value.id,
    teamId: issueForm.value.teamId,
    operatorFarm: store.currentFarm,
  })
  if (!result.ok) errorMessage.value = result.message
  else {
    successMessage.value = result.message
    closeIssue()
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  const payload = listEntries(meta.key, filters.value)
  rows.value = payload.items
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
