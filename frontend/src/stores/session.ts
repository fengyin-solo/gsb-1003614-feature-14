import { defineStore } from 'pinia'

// 系统内的林场口径：当前值班身份所属林场，决定其对哪些物资是“保管林场”。
export const FARMS = ['青山林场', '白云林场', '红岭林场'] as const

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    shiftLabel: '白班 08:00-20:00',
    scope: '森林防火巡护管理系统',
    currentFarm: FARMS[0] as string,
    farms: FARMS as unknown as string[],
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
    // 非保管林场只能查看：物资的储备林场与当前林场不一致时只读。
    isKeeperOf: (state) => (farm: string) => String(farm) === state.currentFarm,
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setFarm(farm: string) {
      this.currentFarm = farm
    },
  },
})
