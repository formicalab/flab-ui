// The Zones and Activity cards fold down to their header with the shared card fold (core/fold.js). Both start folded;
// `state.folds[key]` is true once the user opened one, so the choice survives the redraws of the poll.
import { chevron, foldable } from '../../core/fold.js';
import { card } from '../../core/ui.js';

// `head` are the header nodes after the chevron, `body` the node shown when the card is open.
export const foldCard = (state, key, head, body) =>
  foldable(card([chevron(), ...head], body), state.folds[key] !== true, folded => { state.folds[key] = !folded; });
