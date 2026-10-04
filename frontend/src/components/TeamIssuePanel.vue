<template>
  <section class="link-panel">
    <header class="link-head">
      <h3>队伍领用清单（{{ source }}）</h3>
      <span class="link-tip">出库即扣减实际储备量，清单与可用量跨模块实时重算；同一笔出库重复提交只扣一次。</span>
    </header>
    <table class="data-table">
      <thead>
        <tr>
          <th>领用队伍</th>
          <th>物资类别</th>
          <th>物资名称</th>
          <th>保管林场</th>
          <th>累计领用</th>
          <th>当前实际储备</th>
          <th>可用量(重算)</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in items" :key="`${item.team}-${item.supplyId}`">
          <td>{{ item.team }}</td>
          <td>{{ item.category }}</td>
          <td>{{ item.supplyName }}</td>
          <td>{{ item.farm }}</td>
          <td>{{ item.issued }}</td>
          <td>{{ item.actual }}</td>
          <td>
            <strong :class="item.available > 0 ? 'num-ok' : 'num-zero'">{{ item.available }}</strong>
          </td>
        </tr>
        <tr v-if="!items.length">
          <td colspan="7" class="empty-state">暂无队伍领用记录，可在下方登记出库</td>
        </tr>
      </tbody>
    </table>

    <form class="issue-form" @submit.prevent="submit">
      <label class="filter-item">
        <span>领用队伍</span>
        <select v-model="teamId">
          <option value="">请选择队伍</option>
          <option v-for="team in teams" :key="String(team.id)" :value="Number(team.id)">
            {{ team['队伍名称'] }}（{{ team['所属林场'] }}）
          </option>
        </select>
      </label>
      <label class="filter-item">
        <span>出库物资</span>
        <select v-model="supplyId">
          <option value="">请选择物资</option>
          <option v-for="row in ownSupplies" :key="String(row.id)" :value="Number(row.id)">
            {{ row['物资名称'] }}（{{ row['储备林场'] }}｜实际 {{ row['实际储备量'] }}）
          </option>
        </select>
      </label>
      <label class="filter-item">
        <span>出库数量</span>
        <input v-model.number="quantity" type="number" min="1" max="99999" placeholder="1~99999" />
      </label>
      <button class="btn primary" type="submit">登记出库并重算</button>
    </form>
    <p v-if="message" class="issue-msg" :class="ok ? 'num-ok' : 'error-text'">{{ message }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { listRows } from '@/data/local-store'
import { useReserveStore } from '@/stores/reserve'
import { useSessionStore } from '@/stores/session'
import type { LedgerSource } from '@/stores/reserve'
import type { EntryRow } from '@/data/types'

// 其余模块（消防装备、应急演练、队伍页等）都挂这一个面板，同一份台账驱动，可用量天然同步。
const props = defineProps<{ source: LedgerSource; bus?: number }>()

const reserve = useReserveStore()
const session = useSessionStore()

const teams = ref<EntryRow[]>([])
const teamId = ref<number | ''>('')
const supplyId = ref<number | ''>('')
const quantity = ref<number | null>(null)
const message = ref('')
const ok = ref(false)

const items = computed(() => reserve.teamIssueList)
const ownSupplies = computed(() =>
  reserve.supplyRows.filter((row) => String(row['储备林场']) === session.currentFarm && row.status !== '已过期'),
)

// 装备模块点「领用装备」时可通过 bus 传入预填物资，减少二次选择。
watch(
  () => props.bus,
  (value) => {
    if (value) {
      supplyId.value = value
    }
  },
)

function loadTeams() {
  teams.value = listRows('fireteam')
}

function submit() {
  message.value = ''
  if (teamId.value === '' || supplyId.value === '' || quantity.value === null) {
    message.value = '请完整选择队伍、物资并填写数量'
    ok.value = false
    return
  }
  const team = teams.value.find((item) => Number(item.id) === teamId.value)
  const result = reserve.issueOutbound({
    key: `${props.source}:${Date.now()}:${supplyId.value}:${quantity.value}:${teamId.value}`,
    source: props.source,
    team: team ? String(team['队伍名称']) : '',
    supplyId: Number(supplyId.value),
    quantity: Number(quantity.value),
    ref: `${props.source}出库`,
  })
  ok.value = result.ok
  message.value = result.message
  if (result.ok) {
    quantity.value = null
  }
}

loadTeams()
</script>

<style scoped>
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
.link-tip {
  font-size: 12px;
  color: var(--muted);
}
.issue-form {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: flex-end;
  margin-top: 12px;
}
.issue-form select,
.issue-form input {
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  min-width: 180px;
}
.issue-msg {
  margin: 8px 0 0;
  font-size: 12px;
}
.num-ok {
  color: #15803d;
}
.num-zero {
  color: #b42318;
}
</style>
