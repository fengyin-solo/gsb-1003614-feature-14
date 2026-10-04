<template>
  <section class="page" data-module="fireteam">
    <header class="page-head">
      <div>
        <h2>扑火队伍管理（装备待办联动）</h2>
        <p class="page-desc">物资「确认补充」会向本林场队伍下发装备待办；领取即出库扣减，重复领取只扣一次。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记扑火队伍</button>
        <button class="btn" type="button" @click="exportRows">导出扑火队伍清单</button>
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
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无扑火队伍数据，可先登记扑火队伍</td>
        </tr>
      </tbody>
    </table>

    <section class="link-panel">
      <header class="link-head">
        <h3>队伍装备待办（由物资确认补充联动生成）</h3>
      </header>
      <table class="data-table">
        <thead>
          <tr>
            <th>待办号</th>
            <th>领用队伍</th>
            <th>装备/物资</th>
            <th>数量</th>
            <th>来源</th>
            <th>生成时间</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="todo in reserve.todos" :key="todo.id">
            <td>#{{ todo.id }}</td>
            <td>{{ todo.team }}</td>
            <td>{{ todo.supplyName }}</td>
            <td>{{ todo.quantity }}</td>
            <td>{{ todo.source }}</td>
            <td>{{ todo.createdAt }}</td>
            <td>{{ todo.status }}{{ todo.ledgerId ? `（台账#${todo.ledgerId}）` : '' }}</td>
            <td>
              <button
                v-if="todo.status === '待领用' && session.isKeeperOf(todo.farm)"
                class="link"
                type="button"
                @click="claim(todo.id)"
              >
                领取出库
              </button>
              <span v-else-if="todo.status === '待领用'" class="sub-text">非保管林场</span>
              <span v-else class="sub-text">已出库</span>
            </td>
          </tr>
          <tr v-if="!reserve.todos.length">
            <td colspan="8" class="empty-state">暂无装备待办，物资确认补充后自动生成</td>
          </tr>
        </tbody>
      </table>
    </section>

    <TeamIssuePanel source="队伍领用" />

    <footer class="page-foot">
      <span>共 {{ total }} 条扑火队伍记录</span>
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
import TeamIssuePanel from '@/components/TeamIssuePanel.vue'
import type { EntryRow } from '@/data/types'
import { useReserveStore } from '@/stores/reserve'
import { useSessionStore } from '@/stores/session'

const meta = moduleMeta('fireteam')
const columns = ["队伍编号", "队伍名称", "所属林场", "队长姓名", "队员人数", "集结半径", "值班状态", "出动状态"]
const actions = ["下达出动", "转入休整", "撤回队伍"]
const statuses = ["在营待命", "已出动", "扑救中", "已撤回", "休整中"]

const reserve = useReserveStore()
const session = useSessionStore()

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const stats = computed(() => [
  { label: '队伍总数', value: rows.value.length },
  { label: '待命队伍', value: rows.value.filter((row) => String(row.status) === '在营待命').length },
  { label: '待领取装备', value: reserve.pendingTodos.length },
])

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '扑火队伍登记入口尚未接入审批流'
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

function claim(todoId: number) {
  const result = reserve.claimTodo(todoId)
  errorMessage.value = result.message
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
    errorMessage.value = error instanceof Error ? error.message : '扑火队伍列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.sub-text {
  font-size: 12px;
  color: var(--muted);
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
