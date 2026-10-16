FROM php:8.4-cli-bookworm@sha256:836ac6c672d1372a47c8fd61b625015bd07760f493fb2eaab2087636498a2b4b
COPY phpunit-13.4.2.phar /usr/local/bin/phpunit
RUN chmod 0555 /usr/local/bin/phpunit
USER 65532:65532
WORKDIR /workspace
