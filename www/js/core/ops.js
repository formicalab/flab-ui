// UCI operations as data. A page's model turns the edited form into a list of operations, each
//   { op: 'set' | 'add' | 'delete' | 'order', config, section, type?, name?, id?, values? | options? | sections? }
// so what will be written can be reviewed and unit-tested without a router; stageOps() then stages them through a
// uci API (core/uci.js createUci). Pure: no session and no network of its own.
// An `add` may carry an `id` of its own for the section it creates (an anonymous section is named by rpcd), so that a later
// `order` operation, whose `sections` list holds section names, can refer to it by that id.

// Stages the operations in order through `ed`, a uci API.
export async function stageOps(ed, ops) {
  const created = new Map();
  for (const o of ops) {
    if (o.op === 'set') await ed.set(o.config, o.section, o.values);
    else if (o.op === 'add') {
      const name = await ed.add(o.config, o.type, o.values, o.name);
      if (o.id) created.set(o.id, name);
    } else if (o.op === 'order') await ed.order(o.config, o.sections.map(s => created.get(s) ?? s));
    else await ed.delete(o.config, o.section, o.options);
  }
}
