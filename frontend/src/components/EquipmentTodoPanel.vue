<template>
  <section class="sub-panel">
    <header class="sub-panel-head">
      <h3>扑火队伍装备待办（{{ rows.length }}）</h3>
      <span class="sub-panel-tip">物资确认补充到货后自动生成，办理后回写领用清单</span>
    </header>
    <table class="data-table sub-table">
      <thead>
        <tr>
          <th>来源单号</th>
          <th>承接队伍</th>
          <th>配发物资</th>
          <th>数量</th>
          <th>待办事由</th>
          <th>生成日期</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in rows" :key="item.idemKey">
          <td>{{ item.sourceRef }}</td>
          <td>{{ item.teamName }}</td>
          <td>{{ item.supplyCode }} {{ item.supplyName }}（{{ item.category }}）</td>
          <td>{{ item.qty }}</td>
          <td>{{ item.reason }}</td>
          <td>{{ item.createdAt }}</td>
          <td>
            <button class="link" type="button" @click="finish(item.id)">办理完成</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td colspan="7" class="empty-state">暂无装备待办，确认物资补充后会自动联动生成</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

import { completeTeamTodo, listTeamTodos } from '@/api/supply-chain'
import type { EquipmentTodo } from '@/data/types'

const props = defineProps<{ teamId?: number; readonly?: boolean }>()
const emit = defineEmits<{ (event: 'handled'): void }>()

const rows = ref<EquipmentTodo[]>([])

function reload() {
  rows.value = props.teamId === undefined ? listTeamTodos() : listTeamTodos().filter((item) => item.teamId === props.teamId)
}

function finish(id: number) {
  const result = completeTeamTodo(id)
  if (result.ok) {
    reload()
    emit('handled')
  }
  window.dispatchEvent(new CustomEvent('team-todo-message', { detail: result.message }))
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
