import { defineStore } from 'pinia'

// 林场名单：前两个是拥有物资/装备保管权的保管林场，其余为非保管林场（只能查看）。
export const FARMS = ['青松林场', '云岭林场', '桦木林场', '外县协作林场'] as const
export const KEEPER_FARMS = ['青松林场', '云岭林场'] as const

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    shiftLabel: '白班 08:00-20:00',
    scope: '森林防火巡护管理系统',
    currentFarm: '青松林场' as string,
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
    // 是否为保管林场：非保管林场只能查看，不能盘点、补充或调拨。
    isKeeperFarm: (state) => (KEEPER_FARMS as readonly string[]).includes(state.currentFarm),
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setCurrentFarm(farm: string) {
      this.currentFarm = farm
    },
    // 是否为该行对应储备林场的保管方：只能操作本林场保管的物资。
    isKeeperOf(farm: string): boolean {
      return (this.currentFarm as string) === farm && (KEEPER_FARMS as readonly string[]).includes(farm)
    },
  },
})
