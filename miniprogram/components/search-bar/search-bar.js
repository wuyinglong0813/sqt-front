Component({
  properties: {
    placeholder: { type: String, value: '搜索' },
    value: { type: String, value: '' }
  },
  methods: {
    onInput(e) {
      this.triggerEvent('input', { value: e.detail.value });
    },
    onConfirm(e) {
      this.triggerEvent('confirm', { value: e.detail.value });
    },
    onClear() {
      this.triggerEvent('input', { value: '' });
      this.triggerEvent('clear');
    }
  }
});
