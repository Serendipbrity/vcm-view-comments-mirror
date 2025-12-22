// Default fallback markers for unknown file types
const DEFAULT_LINE_MARKERS = ['#', '//', '--', '%', ';'];

// LINE comment markers per file type (no closing delimiter)
const LINE_COMMENT_MARKERS = {
  // Python-family
  'py': ['#'],
  'python': ['#'],
  'pyx': ['#'],
  'pyi': ['#'],

  // JavaScript / TypeScript
  'js': ['//'],
  'jsx': ['//'],
  'ts': ['//'],
  'tsx': ['//'],

  // C-family
  'c': ['//'],
  'h': ['//'],
  'cpp': ['//'],
  'cc': ['//'],
  'cxx': ['//'],
  'hpp': ['//'],
  'hh': ['//'],
  'ino': ['//'],     // Arduino
  'cs': ['//'],      // C#
  'java': ['//'],
  'swift': ['//'],
  'go': ['//'],
  'rs': ['//'],      // Rust
  'kt': ['//'],      // Kotlin
  'kts': ['//'],     // Kotlin scripts

  // Web / Frontend
  'css': ['/*'],     // note: block style
  'scss': ['//', '/*'],
  'less': ['//', '/*'],
  'html': ['<!--'],
  'htm': ['<!--'],
  'xml': ['<!--'],
  'vue': ['//', '<!--'],
  'svelte': ['//', '<!--'],

  // SQL / DB
  'sql': ['--'],
  'psql': ['--'],
  'plsql': ['--'],
  'mysql': ['--', '#'],

  // Lua / Haskell
  'lua': ['--'],
  'hs': ['--'],
  'lhs': ['--'],

  // Shell / Scripting
  'sh': ['#'],
  'bash': ['#'],
  'zsh': ['#'],
  'ksh': ['#'],
  'fish': ['#'],
  'r': ['#'],
  'rscript': ['#'],
  'pl': ['#'],      // Perl
  'pm': ['#'],      // Perl module
  'rb': ['#'],      // Ruby
  'cr': ['#'],      // Crystal
  'awk': ['#'],
  'tcl': ['#'],

  // PHP / Hack
  'php': ['//', '#'],

  // MATLAB / Octave
  'm': ['%'],
  'matlab': ['%'],
  'octave': ['%'],

  // Assembly / Low-level
  'asm': [';'],
  's': [';'],
  'S': [';'],
  'nas': [';'],

  // Lisp / Scheme / Clojure
  'lisp': [';'],
  'cl': [';'],
  'el': [';'],
  'scm': [';'],
  'ss': [';'],
  'clj': [';'],
  'cljs': [';'],
  'cljc': [';'],

  // Pascal / Delphi
  'pas': ['//'],   // also supports { } and (* *)
  'dpr': ['//'],

  // Fortran
  'f': ['!'],
  'f90': ['!'],
  'f95': ['!'],

  // TeX / LaTeX
  'tex': ['%'],
  'latex': ['%'],

  // VB / Basic
  'vb': ["'"],
  'vbs': ["'"],
  'bas': ["'"],
  'frm': ["'"],

  // PowerShell
  'ps1': ['#'],
  'psm1': ['#'],

  // Config / Data
  'ini': [';', '#'],
  'toml': ['#'],
  'yaml': ['#'],
  'yml': ['#'],
  'env': ['#'],

  // Docs / Markup — no line comments
  'md': [],
  'markdown': [],
  'rst': [],
};

// Get comment markers for a specific file based on extension
// Returns array of comment marker strings for the file type
function getCommentMarkersForFile(filePath) {
  // split the string by the period ex) vcm.js -> ['vcm','js']
  // pop the last el of the array -> ['js']
  // ensure consistency by making it lowercase if it isnt
  const ext = filePath.split('.').pop().toLowerCase();
  // retrieve all markers for the matching index comment_markers['.js'] or default to common markers if undefined (if we dont have that filetype listed)
  return LINE_COMMENT_MARKERS[ext] ?? DEFAULT_LINE_MARKERS;
}

module.exports = {
  getCommentMarkersForFile,
};
