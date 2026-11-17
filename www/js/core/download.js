// Saving generated content as a file through the browser's own download (nothing goes to a server).
import { h } from './dom.js';

// Starts a download of `data` (a string, or a list of Uint8Array parts) as the file `name`. The link is attached to the page
// while it is clicked because Firefox ignores a click on a detached link; the object URL is released afterwards.
export function saveFile(name, data, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob(Array.isArray(data) ? data : [data], { type }));
  const link = h('a', { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
