import assert from 'node:assert/strict';

// DOM inspection pierces the closed shadow root only in the test CDP transport.
// Hit the actual live rectangles, independent of corner, browser zoom or OS font.
export async function clickOverlayControl(client, className) {
  const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true }, 3000);
  function find(node, withinOverlay = false) {
    const attrs = node.attributes || [];
    const id = attrs.indexOf('id');
    const classes = attrs.indexOf('class');
    const inside = withinOverlay || (id >= 0 && attrs[id + 1] === '__pp-agent-overlay');
    if (inside && classes >= 0 && attrs[classes + 1].split(' ').includes(className)) return node;
    for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) {
      const found = find(child, inside);
      if (found) return found;
    }
    return null;
  }
  const node = find(root);
  assert.ok(node, `Overlay control .${className} should exist`);
  const { model } = await client.send('DOM.getBoxModel', { nodeId: node.nodeId }, 3000);
  const quad = model.border;
  const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
  const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, 3000);
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, 3000);
}

export async function endOverlayTask(client) {
  await clickOverlayControl(client, 'more');
  await clickOverlayControl(client, 'stop');
  await clickOverlayControl(client, 'stop');
}
