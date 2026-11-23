// What the common dialplan applications do, for the step listing of the Dialplan tab. Asterisk 23 on OpenWrt ships without its XML
// documentation (`core show application` is empty), so the descriptions are kept here, written from the Asterisk 23 application reference
// (https://docs.asterisk.org/Asterisk_23_Documentation/API_Documentation/Dialplan_Applications/). Unknown applications simply have no text.

// Category -> label shown in the legend; the category also colors the application chip (css/asterisk.css, .ast-app.<category>).
export const APP_CATEGORIES = {
  dial: 'Places a call',
  flow: 'Controls the flow',
  media: 'Plays or reads media',
  vars: 'Variables and logging',
  end: 'Ends the call',
  script: 'Runs a script',
  other: 'Other',
};

const APPS = {
  Dial: ['dial', 'Calls one or more channels (PJSIP/…, Local/…) and bridges the caller to the first that answers. Sets DIALSTATUS.'],
  Queue: ['dial', 'Puts the caller in a call queue.'],
  Originate: ['dial', 'Places a call and connects it to an extension or application.'],
  Page: ['dial', 'Calls several channels at once for an announcement or intercom.'],
  FollowMe: ['dial', 'Tries a list of numbers one after the other.'],
  Goto: ['flow', 'Jumps to another priority, extension or context: Goto([[context,]exten,]priority-or-label).'],
  GotoIf: ['flow', 'Jumps to one of two destinations depending on a condition: GotoIf(cond?then:else).'],
  GotoIfTime: ['flow', 'Jumps depending on the time of day, week or year.'],
  Gosub: ['flow', 'Calls a subroutine and comes back after Return.'],
  GosubIf: ['flow', 'Calls one of two subroutines depending on a condition.'],
  Return: ['flow', 'Returns from a subroutine.'],
  ExecIf: ['flow', 'Runs an application only when a condition is true.'],
  Exec: ['flow', 'Runs another application by name.'],
  While: ['flow', 'Starts a loop that runs while the condition is true.'],
  EndWhile: ['flow', 'Ends a While loop.'],
  ExitWhile: ['flow', 'Leaves a While loop.'],
  ContinueWhile: ['flow', 'Goes back to the top of a While loop.'],
  Macro: ['flow', 'Calls a macro (deprecated; use Gosub).'],
  Set: ['vars', 'Sets a channel variable or a dialplan function.'],
  MSet: ['vars', 'Sets several channel variables at once.'],
  NoOp: ['vars', 'Does nothing; its text appears in the verbose log. Used for comments.'],
  Log: ['vars', 'Writes a line to the Asterisk log.'],
  UserEvent: ['vars', 'Sends a custom event to the manager interface.'],
  Verbose: ['vars', 'Prints text to the verbose log.'],
  Answer: ['media', 'Answers the call so that media can flow.'],
  Progress: ['media', 'Sends early media (call progress) without answering.'],
  Ringing: ['media', 'Tells the caller that the line is ringing.'],
  Playback: ['media', 'Plays a sound file and goes on (no key detection).'],
  Background: ['media', 'Plays a sound file while waiting for digits.'],
  BackGround: ['media', 'Plays a sound file while waiting for digits.'],
  Read: ['media', 'Plays a prompt and reads digits into a variable.'],
  PlayTones: ['media', 'Plays a tone (dial, ring, busy…) until StopPlayTones.'],
  StopPlayTones: ['media', 'Stops the tone started by PlayTones.'],
  Wait: ['media', 'Waits for a number of seconds.'],
  WaitExten: ['media', 'Waits for the caller to dial an extension.'],
  MusicOnHold: ['media', 'Plays music on hold.'],
  Echo: ['media', 'Sends the caller’s audio back to them (echo test).'],
  SayNumber: ['media', 'Speaks a number.'],
  SayDigits: ['media', 'Speaks digits one by one.'],
  Record: ['media', 'Records the caller to a file.'],
  MixMonitor: ['media', 'Records both sides of a call.'],
  SendDTMF: ['media', 'Sends DTMF digits to the channel.'],
  Hangup: ['end', 'Ends the call.'],
  Busy: ['end', 'Plays the busy tone and ends the call.'],
  Congestion: ['end', 'Plays the congestion tone and ends the call.'],
  AGI: ['script', 'Runs an AGI script that controls the call (a program in the agi-bin directory).'],
  EAGI: ['script', 'Like AGI, with the caller’s audio on file descriptor 3.'],
  System: ['script', 'Runs a shell command.'],
  TrySystem: ['script', 'Runs a shell command and continues even if it fails.'],
  Authenticate: ['other', 'Asks for a password (its argument is hidden here).'],
  DISA: ['other', 'Gives the caller a second dial tone after a passcode (its argument is hidden here).'],
};

// { cat, text } for an application name (case as in the dialplan); unknown names are category 'other' with no text.
export function appInfo(name) {
  const known = APPS[name];
  return known ? { cat: known[0], text: known[1] } : { cat: 'other', text: '' };
}
