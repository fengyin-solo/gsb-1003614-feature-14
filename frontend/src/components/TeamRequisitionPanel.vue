<template>
  <section class="sub-panel">
    <header class="sub-panel-head">
      <h3>队伍领用清单（{{ rows.length }}）</h3>
      <span class="sub-panel-tip">可用量随调拨/出库实时重算，重复出库只扣一次</span>
    </header>
    <table class="data-table sub-table">
      <thead>
        <tr>
          <th>单号</th>
          <th>来源</th>
          <th>类别</th>
          <th>物资/装备</th>
          <th>领用队伍</th>
          <th>出库数量</th>
          <th>当前可用量</th>
          <th>出库日期</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in rows" :key="`${item.refCode}-${item.itemId}-${item.idemKey}`">
          <td>{{ item.refCode }}</td>
          <td>{{ item.sourceModule }}</td>
          <td>
            <span class="badge" :class="item.entryType === '物资' ? 'badge-mat' : 'badge-eq'">{{ item.entryType }}</span>
            {{ item.category }}
          </td>
          <td>{{ item.itemCode }} {{ item.itemName }}</td>
          <td>{{ item.teamName }}</td>
          <td>{{ item.qty }}</td>
          <td>
            <span :class="item.available > 0 ? 'qty-ok' : 'qty-zero'">{{ item.available }}</span>
          </td>
          <td>{{ item.createdAt }}</td>
        </tr>
        <tr v-if="!rows.length">
          <td colspan="8" class="empty-state">暂无队伍领用记录，物资调拨或装备领用后会自动写入清单</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

import { buildTeamRequisitions, type TeamRequisitionView } from '@/api/supply-chain'

// 其余模块复用同一份队伍领用清单：挂到哪个模块就显示哪份实时数据，可用量统一重算。
const rows = ref<TeamRequisitionView[]>([])

function reload() {
  rows.value = buildTeamRequisitions()
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
