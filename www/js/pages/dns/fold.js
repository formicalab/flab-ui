// A card that folds down to its header, used by the Forwarding and Activity cards of the DNS page. The card is closed until
// its header is clicked; whether it is open is kept in `state.folds[key]`, so the choice survives the redraws of the poll.
import { h } from '../../core/dom.js';

// `head` are the nodes after the chevron in the header, `body` the node shown when open.
export function foldCard(state, key, head, body) {
  return h('div', { className: 'card' },
    h('details', { className: 'dns-fold', open: state.folds[key] === true, ontoggle: ev => { state.folds[key] = ev.target.open; } },
      h('summary', { className: 'card-header' }, h('span', { className: 'dns-chevron' }), ...head), body));
}
