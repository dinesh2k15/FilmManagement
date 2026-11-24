// Every check happens on the server. The client only uses this list to decide which tabs to show.
export const ROLES = ['producer', 'director', 'writer', 'lineprod', 'manager', 'financier'];

const ALL = [
  'view:overview', 'view:schedule', 'edit:dates', 'edit:schedule', 'record:actual',
  'view:contracts', 'edit:usage', 'edit:contracts',
  'view:changes', 'request:change', 'decide:change',
  'view:crew', 'edit:crew', 'view:bills', 'edit:bills',
  'script', 'manage:team',
];

export const CAPS = {
  producer: ALL,
  director: ['view:overview', 'view:schedule', 'view:changes', 'request:change', 'script'],
  writer: ['view:changes', 'request:change', 'script'],
  lineprod: ['view:overview', 'view:schedule', 'edit:dates', 'edit:schedule', 'record:actual',
    'view:contracts', 'edit:usage', 'view:changes', 'request:change',
    'view:crew', 'edit:crew', 'view:bills', 'edit:bills'],
  // An actor's manager edits dates only for the actors they represent (checked per actor).
  manager: ['view:schedule', 'edit:dates', 'view:contracts'],
  financier: ['view:overview', 'view:changes', 'view:bills'],
};

export const can = (role, cap) => !!CAPS[role]?.includes(cap);

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
