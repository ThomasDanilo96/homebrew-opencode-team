class OpencodeTeam < Formula
  desc "Portable runtime foundation for OpenCode Team"
  homepage "https://github.com/ThomasDanilo96/homebrew-opencode-team"
  url "https://github.com/ThomasDanilo96/homebrew-opencode-team/archive/refs/tags/v0.1.0.tar.gz"
  version "0.1.0"
  sha256 "e190f8e0e1983c6323b5231f2fe24496472dba37afaaf609f9b3f79fd9be1724"
  license "MIT"

  depends_on "anomalyco/tap/opencode"
  depends_on "git"
  depends_on "jq"
  depends_on "node@22"
  depends_on "python@3.14"
  depends_on "ripgrep"
  depends_on "tmux"
  depends_on "uv"

  def install
    libexec.install "bin", "core", "shared", "teams", "tests", "VERSION"
    (bin/"opencode-team").write <<~EOS
      #!/bin/bash
      node22="#{Formula["node@22"].opt_bin}/node"
      simdjson_name="$(otool -L "$node22" 2>/dev/null | while IFS= read -r line; do case "$line" in *libsimdjson.*.dylib*) printf '%s\\n' "${line##*/}"; break;; esac; done)"
      if [ -n "$simdjson_name" ]; then
        for simdjson_lib in "$(brew --cellar simdjson)"/*/lib/"$simdjson_name"; do
          if [ -f "$simdjson_lib" ]; then
            export DYLD_LIBRARY_PATH="${simdjson_lib%/*}${DYLD_LIBRARY_PATH:+:$DYLD_LIBRARY_PATH}"
            break
          fi
        done
      fi
      export PATH="#{Formula["node@22"].opt_bin}:$PATH"
      exec "#{libexec}/bin/opencode-team" "$@"
    EOS
    chmod 0755, bin/"opencode-team"
  end

  test do
    assert_match "OpenCode Team 0.1.0", shell_output("#{bin}/opencode-team version")
    assert_match "opencode-team start", shell_output("#{bin}/opencode-team --help")
  end
end
