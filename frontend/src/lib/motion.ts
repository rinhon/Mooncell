/** 位移、缩放、旋转与透明度共用预设；减少动态效果时由调用方直接呈现终态。 */
export const spring = {
  snappy: { type: "spring", stiffness: 400, damping: 30 },
  gentle: { type: "spring", stiffness: 300, damping: 30 },
  layout: { type: "spring", stiffness: 320, damping: 30 },
  press: { type: "spring", stiffness: 500, damping: 40 },
} as const
