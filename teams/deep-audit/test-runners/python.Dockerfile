FROM python:3.13-slim-bookworm@sha256:a1165e272e578941b84abc79e4ab38a0305cd12803a5c4247979ac7655f4d641
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_CACHE_DIR=1 PYTHONNOUSERSITE=1
COPY python-requirements.txt /tmp/python-requirements.txt
RUN python -m pip install --no-cache-dir --requirement /tmp/python-requirements.txt
RUN python -m pip check
USER 65532:65532
WORKDIR /workspace
