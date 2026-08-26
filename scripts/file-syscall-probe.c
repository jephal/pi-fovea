// Minimal compiled validator for `strace -e trace=%file` output. It rejects
// write-capable pathname syscalls outside the supplied private cache and
// overflow directories. The trace producer is intentionally separate: tracing
// this process would make its own report-file reads part of the assertion.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int allowed(const char *path, const char *cache, const char *overflow) {
  size_t n = strlen(cache);
  if (!strncmp(path, cache, n) && (path[n] == '\0' || path[n] == '/')) return 1;
  n = strlen(overflow);
  if (!strncmp(path, overflow, n) && (path[n] == '\0' || path[n] == '/')) return 1;
  return !strncmp(path, "/dev/", 5);
}

static int writes_path(const char *line) {
  return (strstr(line, "open(") || strstr(line, "openat(")) &&
    (strstr(line, "O_WRONLY") || strstr(line, "O_RDWR") || strstr(line, "O_CREAT") || strstr(line, "O_TRUNC"));
}

int main(int argc, char **argv) {
  if (argc != 4) {
    fprintf(stderr, "usage: %s TRACE PRIVATE_CACHE PRIVATE_OVERFLOW\n", argv[0]);
    return 2;
  }
  FILE *trace = fopen(argv[1], "r");
  if (!trace) { perror(argv[1]); return 2; }
  char line[16384];
  int bad = 0;
  while (fgets(line, sizeof line, trace)) {
    if (!writes_path(line)) continue;
    for (char *p = line; (p = strchr(p, '"'));) {
      char *end = strchr(++p, '"');
      if (!end) break;
      *end = '\0';
      if (p[0] == '/' && !allowed(p, argv[2], argv[3])) {
        fprintf(stderr, "unexpected write-capable file syscall: %s\n", p);
        bad = 1;
      }
      p = end + 1;
    }
  }
  fclose(trace);
  return bad;
}
