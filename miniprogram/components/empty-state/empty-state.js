Component({
  properties: {
    imageSrc: { type: String, value: '/images/mascot.png' },
    text: { type: String, value: '暂无数据' },
    buttonText: { type: String, value: '' },
    compact: { type: Boolean, value: false }
  },
  methods: {
    onTap() {
      this.triggerEvent('tap');
    }
  }
});
