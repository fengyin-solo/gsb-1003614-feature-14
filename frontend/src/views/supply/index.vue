<template>
  <section class="page" data-module="supply">
    <header class="page-head">
      <div>
        <h2>物资储备管理（动态储备口径）</h2>
        <p class="page-desc">
          按物资类别比较预警储备量与实际储备量，结合林场需求（动态基线取二者大值）给出充足、偏低、需补充建议；
          历史缺预警储备量按同类物资中位数兼容。当前林场：<strong>{{ session.currentFarm }}</strong>
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记防火物资</button>
        <button class="btn" type="button" @click="exportRows">导出物资储备清单</button>
      </div>
    </header>

    <p class="readonly-banner">
      非保管林场只能查看：当前身份为{{ session.currentFarm }}，其他林场物资的盘点、补充、出库类操作已禁用（切换顶部林场可切换保管身份）。
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
      <label class="filter-item">
        <span>储备林场</span>
        <select v-model="farmFilter">
          <option value="">全部林场</option>
          <option v-for="farm in session.farms" :key="farm" :value="farm">{{ farm }}</option>
        </select>
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>动态基线(预警/需求)</th>
          <th>系统建议</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ formatCell(row, column) }}</td>
          <td>
            {{ evalOf(row).baseline }}
            <span class="sub-text">（预警{{ evalOf(row).warningEffective ?? '中位数兜底' }}/需求{{ evalOf(row).demand ?? 0 }}）</span>
          </td>
          <td class="advice-cell">{{ evalOf(row).advice }}</td>
          <td>
            <span :class="['status-tag', `st-${evalOf(row).status}`]">{{ evalOf(row).status }}</span>
          </td>
          <td class="row-actions">
            <template v-if="canEdit(row)">
              <button class="link" type="button" @click="openStocktake(row)">人工盘点</button>
              <button
                v-if="evalOf(row).gap > 0 && evalOf(row).status !== '已过期'"
                class="link"
                type="button"
                @click="openRequest(row)"
              >
                发起补充
              </button>
              <button
                v-if="evalOf(row).status !== '已过期'"
                class="link danger"
                type="button"
                @click="markExpired(row)"
              >
                标记过期
              </button>
            </template>
            <span v-else class="readonly-text">只读（非保管林场）</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 4" class="empty-state">暂无物资储备数据，可先登记防火物资</td>
        </tr>
      </tbody>
    </table>

    <section class="link-panel">
      <header class="link-head">
        <h3>补充申请与确认（确认即联动扑火队伍装备待办，重复确认只入库一次）</h3>
      </header>
      <table class="data-table">
        <thead>
          <tr>
            <th>申请号</th>
            <th>物资</th>
            <th>保管林场</th>
            <th>数量</th>
            <th>申请时间</th>
            <th>状态</th>
            <th>接收队伍</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="request in reserve.replenishRequests" :key="request.id">
            <td>#{{ request.id }}</td>
            <td>{{ supplyName(request.supplyId) }}</td>
            <td>{{ request.farm }}</td>
            <td>{{ request.quantity }}</td>
            <td>{{ request.createdAt }}</td>
            <td>{{ request.status }}{{ request.todoId ? `（待办#${request.todoId}）` : '' }}</td>
            <td>
              <select
                v-if="request.status === '待确认' && session.isKeeperOf(request.farm)"
                v-model="teamChoice[request.id]"
              >
                <option value="">选择扑火队伍</option>
                <option v-for="team in teams" :key="String(team.id)" :value="Number(team.id)">
                  {{ team['队伍名称'] }}
                </option>
              </select>
              <span v-else>—</span>
            </td>
            <td>
              <button
                v-if="request.status === '待确认' && session.isKeeperOf(request.farm)"
                class="link"
                type="button"
                @click="confirmRequest(request.id)"
              >
                确认补充
              </button>
              <span v-else class="sub-text">{{ request.status === '已确认' ? '已完成' : '无权确认' }}</span>
            </td>
          </tr>
          <tr v-if="!reserve.replenishRequests.length">
            <td colspan="8" class="empty-state">暂无补充申请</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="link-panel">
      <header class="link-head">
        <h3>物资联动台账（人工盘点 / 火情调拨 / 队伍领用 / 补充入库）</h3>
      </header>
      <table class="data-table">
        <thead>
          <tr>
            <th>时间</th>
            <th>类型</th>
            <th>来源</th>
            <th>林场</th>
            <th>物资</th>
            <th>数量变动</th>
            <th>关联单据</th>
            <th>操作人</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="entry in reserve.ledger.slice(0, 12)" :key="entry.id">
            <td>{{ entry.time }}</td>
            <td>{{ entry.kind }}</td>
            <td>{{ entry.source }}</td>
            <td>{{ entry.farm }}</td>
            <td>{{ entry.supplyId > 0 ? entry.supplyName : '—' }}</td>
            <td :class="entry.quantity > 0 ? 'num-ok' : entry.quantity < 0 ? 'num-zero' : ''">
              {{ entry.quantity > 0 ? `+${entry.quantity}` : entry.quantity }}
            </td>
            <td>{{ entry.ref }}</td>
            <td>{{ entry.operator }}</td>
          </tr>
          <tr v-if="!reserve.ledger.length">
            <td colspan="8" class="empty-state">暂无台账记录</td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 登记物资 -->
    <dialog ref="createDialog" class="modal">
      <form method="dialog" class="modal-card" @submit.prevent="submitCreate">
        <h3>登记防火物资</h3>
        <p class="sub-text">保管林场：{{ session.currentFarm }}；数量越界（非 0~{{ quantityMax }} 整数）不允许保存。</p>
        <label><span>物资名称*</span><input v-model="createForm.name" /></label>
        <label><span>物资类别*</span><input v-model="createForm.category" placeholder="如 灭火机具" /></label>
        <label><span>规格型号</span><input v-model="createForm.spec" /></label>
        <label><span>预警储备量（可空，空则按同类中位数兼容）</span><input v-model.number="createForm.warning" type="number" min="0" /></label>
        <label><span>林场需求量（可空）</span><input v-model.number="createForm.demand" type="number" min="0" /></label>
        <label><span>实际储备量*</span><input v-model.number="createForm.actual" type="number" min="0" /></label>
        <p v-if="modalError" class="error-text">{{ modalError }}</p>
        <footer class="modal-actions">
          <button class="btn" type="button" @click="closeCreate">取消</button>
          <button class="btn primary" type="submit">保存并计算口径</button>
        </footer>
      </form>
    </dialog>

    <!-- 人工盘点（盘点优先） -->
    <dialog v-if="stockTarget" ref="stockDialog" class="modal">
      <form method="dialog" class="modal-card" @submit.prevent="submitStocktake">
        <h3>人工盘点：{{ stockTarget['物资名称'] }}</h3>
        <p class="sub-text">
          当前账面实际量 {{ stockTarget['实际储备量'] }}，动态基线 {{ evalOf(stockTarget).baseline }}。
          规则：人工盘点优先于系统建议，保存后按实盘数重算状态与建议。
        </p>
        <label><span>现场实盘数量*</span><input v-model.number="stockCount" type="number" min="0" :max="quantityMax" autofocus /></label>
        <label><span>盘点备注</span><input v-model="stockNote" placeholder="差异原因（可选）" /></label>
        <p v-if="modalError" class="error-text">{{ modalError }}</p>
        <footer class="modal-actions">
          <button class="btn" type="button" @click="stockTarget = null">取消</button>
          <button class="btn primary" type="submit">按盘点保存</button>
        </footer>
      </form>
    </dialog>

    <!-- 发起补充 -->
    <dialog v-if="requestTarget" ref="requestDialog" class="modal">
      <form method="dialog" class="modal-card" @submit.prevent="submitRequest">
        <h3>发起补充：{{ requestTarget['物资名称'] }}</h3>
        <p class="sub-text">{{ evalOf(requestTarget).advice }}</p>
        <label><span>补充数量*</span><input v-model.number="requestQty" type="number" min="1" max="99999" /></label>
        <p v-if="modalError" class="error-text">{{ modalError }}</p>
        <footer class="modal-actions">
          <button class="btn" type="button" @click="requestTarget = null">取消</button>
          <button class="btn primary" type="submit">提交申请</button>
        </footer>
      </form>
    </dialog>

    <footer class="page-foot">
      <span>共 {{ total }} 条物资储备记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
} from '@/api/local-service'
import { listRows } from '@/data/local-store'
import { QUANTITY_MAX } from '@/data/supply-policy'
import type { EntryRow } from '@/data/types'
import { useReserveStore, type ReplenishRequest } from '@/stores/reserve'
import { useSessionStore } from '@/stores/session'

const meta = moduleMeta('supply')
const columns = ["物资编号", "物资名称", "物资类别", "规格型号", "储备林场", "预警储备量", "林场需求量", "实际储备量", "最近盘点时间"]
const statuses = ["充足", "偏低", "需补充", "已过期"]
const quantityMax = QUANTITY_MAX

const reserve = useReserveStore()
const session = useSessionStore()

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const farmFilter = ref('')
const filterFields = ["物资编号", "物资名称", "物资类别"]
const teams = ref<EntryRow[]>([])
const teamChoice = reactive<Record<number, number | ''>>({})

const stats = computed(() => {
  const all = reserve.supplyRows
  return [
    { label: '物资种类', value: all.length },
    { label: '需补充种类', value: all.filter((row) => reserve.evaluation(row).status === '需补充').length },
    { label: '偏低种类', value: all.filter((row) => reserve.evaluation(row).status === '偏低').length },
    { label: '过期种类', value: all.filter((row) => reserve.evaluation(row).status === '已过期').length },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: reserve.supplyRows.filter((row) => reserve.evaluation(row).status === status).length,
  })),
)

// 缓存每条物资的口径计算，模板里多次引用时算一次
const evalCache = computed(() => {
  const map = new Map<number, ReturnType<typeof reserve.evaluation>>()
  for (const row of reserve.supplyRows) {
    map.set(Number(row.id), reserve.evaluation(row))
  }
  return map
})
function evalOf(row: EntryRow) {
  return evalCache.value.get(Number(row.id)) ?? reserve.evaluation(row)
}

function canEdit(row: EntryRow): boolean {
  return session.isKeeperOf(String(row['储备林场']))
}

function formatCell(row: EntryRow, column: string): string | number {
  if (column === '预警储备量') {
    const value = row[column]
    const evaluation = evalOf(row)
    return value === '' || value === undefined
      ? `缺（同类中位数${evaluation.warningEffective ?? '无'}）`
      : (value as number)
  }
  if (column === '最近盘点时间') {
    return String(row['盘点时间'] ?? '—')
  }
  return String(row[column] ?? '—')
}

function supplyName(id: number): string {
  return reserve.findSupply(id)?.['物资名称'] as string ?? `物资#${id}`
}

function resetFilters() {
  filters.value = {}
  farmFilter.value = ''
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

// —— 登记 ——
const createDialog = ref<HTMLDialogElement | null>(null)
const modalError = ref('')
const createForm = reactive({ name: '', category: '', spec: '', warning: null as number | null, demand: null as number | null, actual: 0 })

function openCreate() {
  modalError.value = ''
  Object.assign(createForm, { name: '', category: '', spec: '', warning: null, demand: null, actual: 0 })
  createDialog.value?.showModal()
}
function closeCreate() {
  createDialog.value?.close()
}
function submitCreate() {
  const result = reserve.registerSupply({ ...createForm })
  if (!result.ok) {
    modalError.value = result.message
    return
  }
  errorMessage.value = result.message
  closeCreate()
  reload()
}

// —— 人工盘点 ——
const stockDialog = ref<HTMLDialogElement | null>(null)
const stockTarget = ref<EntryRow | null>(null)
const stockCount = ref<number | null>(null)
const stockNote = ref('')

function openStocktake(row: EntryRow) {
  stockTarget.value = row
  stockCount.value = Number(row['实际储备量'])
  stockNote.value = ''
  modalError.value = ''
  // v-if 渲染后再弹窗
  setTimeout(() => stockDialog.value?.showModal(), 0)
}
function submitStocktake() {
  if (!stockTarget.value || stockCount.value === null) {
    modalError.value = '请填写现场实盘数量'
    return
  }
  const result = reserve.stocktake(Number(stockTarget.value.id), Number(stockCount.value), stockNote.value)
  modalError.value = result.ok ? '' : result.message
  if (result.ok) {
    errorMessage.value = result.message
    stockTarget.value = null
    reload()
  }
}

// —— 发起补充 ——
const requestDialog = ref<HTMLDialogElement | null>(null)
const requestTarget = ref<EntryRow | null>(null)
const requestQty = ref<number | null>(null)

function openRequest(row: EntryRow) {
  requestTarget.value = row
  requestQty.value = evalOf(row).gap
  modalError.value = ''
  setTimeout(() => requestDialog.value?.showModal(), 0)
}
function submitRequest() {
  if (!requestTarget.value || requestQty.value === null) {
    modalError.value = '请填写补充数量'
    return
  }
  const result = reserve.requestReplenish(Number(requestTarget.value.id), Number(requestQty.value))
  modalError.value = result.ok ? '' : result.message
  if (result.ok) {
    errorMessage.value = result.message
    requestTarget.value = null
    reload()
  }
}

function confirmRequest(requestId: number) {
  const teamId = teamChoice[requestId]
  if (!teamId) {
    errorMessage.value = '请先选择接收装备的扑火队伍'
    return
  }
  const result = reserve.confirmReplenish(requestId, Number(teamId))
  errorMessage.value = result.message
}

function markExpired(row: EntryRow) {
  const result = reserve.markExpired(Number(row.id))
  errorMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  reserve.init()
  const merged = { ...filters.value }
  if (farmFilter.value) {
    merged['储备林场'] = farmFilter.value
  }
  const payload = listEntries(meta.key, merged)
  rows.value = payload.items
  total.value = payload.total
  teams.value = listRows('fireteam')
}

onMounted(reload)
</script>

<style scoped>
.readonly-banner {
  background: #fff7ed;
  border: 1px solid #fdba74;
  color: #9a3412;
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 13px;
}
.sub-text {
  font-size: 12px;
  color: var(--muted);
}
.advice-cell {
  font-size: 12px;
  max-width: 260px;
}
.readonly-text {
  font-size: 12px;
  color: var(--muted);
}
.link.danger {
  color: #b42318;
}
.status-tag {
  display: inline-block;
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
}
.st-充足 {
  background: #dcfce7;
  color: #15803d;
}
.st-偏低 {
  background: #fef9c3;
  color: #a16207;
}
.st-需补充 {
  background: #fee2e2;
  color: #b42318;
}
.st-已过期 {
  background: #e5e7eb;
  color: #475569;
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
.num-ok {
  color: #15803d;
}
.num-zero {
  color: #b42318;
}
.modal {
  border: none;
  border-radius: 10px;
  padding: 0;
}
.modal::backdrop {
  background: rgba(15, 23, 42, 0.45);
}
.modal-card {
  width: 420px;
  padding: 18px 20px;
}
.modal-card h3 {
  margin: 0 0 6px;
}
.modal-card label {
  display: block;
  margin: 10px 0;
  font-size: 13px;
}
.modal-card input {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  margin-top: 2px;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}
</style>
