<script setup>
import ballUrl from '../../common/assets/ball.png'

let downX = 0
let downY = 0

function down(e) {
  downX = e.screenX
  downY = e.screenY
}

function up(e) {
  if (Math.abs(e.screenX - downX) < 5 && Math.abs(e.screenY - downY) < 5) {
    window.api.activate()
  }
}
</script>

<template>
  <div
    class="w-14 h-14 rounded-full overflow-hidden shadow-lg select-none"
    style="-webkit-app-region: drag"
    @mousedown="down"
    @mouseup="up"
  >
    <img :src="ballUrl" class="w-full h-full pointer-events-none" draggable="false" />
  </div>
</template>

<style>
html,
body {
  background: transparent !important;
}
</style>
