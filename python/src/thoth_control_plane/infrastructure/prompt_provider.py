"""Safe catalog projection and the one-request OpenAI-compatible adapter (C2)."""

from __future__ import annotations

import json
from typing import Any

import httpx

from thoth_control_plane.application.prompt_proposal_ports import (
    ProviderInvalidOutput,
    ProviderRateLimited,
    ProviderTimeout,
    ProviderUnavailable,
)
from thoth_control_plane.config import PromptProviderRuntimeDefinition, Settings
from thoth_control_plane.domain.prompt_proposals import (
    PromptProviderDefinition,
    ProviderPromptRequest,
    ProviderPromptResult,
)

REQUEST_TIMEOUT_SECONDS = 120.0


def public_prompt_provider_catalog(
    settings: Settings,
) -> tuple[PromptProviderDefinition, ...]:
    """Project the runtime catalog onto the browser-safe shape; no endpoints or credentials."""
    public: list[PromptProviderDefinition] = []
    for runtime in settings.THOTH_PROMPT_PROVIDER_CATALOG:
        if not runtime.enabled:
            continue
        public.append(
            PromptProviderDefinition.model_validate(
                {
                    "provider_id": runtime.provider_id,
                    "label": runtime.label,
                    "enabled": True,
                    "models": [model.model_dump(mode="json") for model in runtime.models],
                }
            )
        )
    return tuple(public)


class OpenAICompatiblePromptProvider:
    """Perform exactly one OpenAI-compatible chat-completions request per invocation."""

    def __init__(
        self,
        *,
        runtime_catalog: tuple[PromptProviderRuntimeDefinition, ...],
        secrets: dict[str, Any],
        transport: httpx.AsyncBaseTransport | None = None,
        timeout: float = REQUEST_TIMEOUT_SECONDS,
        follow_redirects: bool = False,
    ) -> None:
        self._runtime_catalog = tuple(
            item
            if isinstance(item, PromptProviderRuntimeDefinition)
            else PromptProviderRuntimeDefinition.model_validate(item)
            for item in runtime_catalog
        )
        self._secrets = secrets
        self._transport = transport
        self._timeout = timeout
        self._follow_redirects = follow_redirects

    @property
    def request_timeout_seconds(self) -> float:
        return self._timeout

    @property
    def follow_redirects_enabled(self) -> bool:
        return self._follow_redirects

    async def propose(self, request: ProviderPromptRequest) -> ProviderPromptResult:
        runtime = self._resolve_runtime(request.provider_id)
        self._enforce_catalog(runtime, request)
        credential = self._secrets.get(runtime.credential_id)
        if credential is None or not credential.get_secret_value().strip():
            raise ProviderUnavailable()
        payload = self._build_payload(runtime, request)
        try:
            async with httpx.AsyncClient(
                timeout=self._timeout,
                follow_redirects=self._follow_redirects,
                transport=self._transport,
            ) as client:
                response = await client.post(
                    f"{runtime.base_url}/chat/completions",
                    headers={
                        "Authorization": f"Bearer {credential.get_secret_value()}",
                        "Content-Type": "application/json",
                    },
                    json=payload,
                )
        except httpx.TimeoutException as error:
            raise ProviderTimeout() from error
        except httpx.HTTPError as error:
            raise ProviderUnavailable() from error
        if response.status_code == 429:
            raise ProviderRateLimited()
        if response.status_code >= 400:
            raise ProviderUnavailable()
        content = self._extract_content(response)
        return self._validate_output(request, content)

    def _resolve_runtime(self, provider_id: str) -> PromptProviderRuntimeDefinition:
        for runtime in self._runtime_catalog:
            if runtime.provider_id == provider_id and runtime.enabled:
                return runtime
        raise ProviderUnavailable()

    @staticmethod
    def _enforce_catalog(
        runtime: PromptProviderRuntimeDefinition, request: ProviderPromptRequest
    ) -> None:
        for model in runtime.models:
            if model.model_id == request.model_id:
                if request.kind not in model.capabilities:
                    raise ProviderInvalidOutput()
                total_chars = sum(len(text) for text in request.text_by_layer.values())
                if total_chars > model.max_input_chars:
                    raise ProviderInvalidOutput()
                return
        raise ProviderUnavailable()

    @staticmethod
    def _build_payload(
        runtime: PromptProviderRuntimeDefinition, request: ProviderPromptRequest
    ) -> dict[str, Any]:
        layers_block = "\n\n".join(
            f"[{layer}]\n{text}" for layer, text in request.text_by_layer.items()
        )
        if request.kind == "translate":
            task = (
                f"Translate every labeled prompt layer into {request.target_language}. "
                "Return a JSON object whose keys are exactly the layer labels shown and "
                "whose values are the translated layer text."
            )
        else:
            task = (
                "Improve the labeled prompt layer. Return a JSON object whose keys are "
                "exactly the layer labels shown and whose values are the improved layer text."
            )
        instructions = (
            f"Improvement instructions: {request.improvement_instructions}"
            if request.improvement_instructions
            else ""
        )
        system = f"{request.hidden_instruction}\n{task}\nRespond with JSON only."
        user = f"{layers_block}\n{instructions}".strip()
        return {
            "model": request.model_id,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": 0,
        }

    @staticmethod
    def _extract_content(response: httpx.Response) -> str:
        try:
            body = response.json()
            content = body["choices"][0]["message"]["content"]
            if not isinstance(content, str):
                raise ProviderInvalidOutput()
            return content
        except ProviderInvalidOutput:
            raise
        except Exception as error:
            raise ProviderInvalidOutput() from error

    def _validate_output(
        self, request: ProviderPromptRequest, content: str
    ) -> ProviderPromptResult:
        try:
            parsed = json.loads(content)
            if not isinstance(parsed, dict):
                raise ProviderInvalidOutput()
            if set(parsed) != set(request.text_by_layer):
                raise ProviderInvalidOutput()
            text_by_layer = {layer: str(parsed[layer]) for layer in request.text_by_layer}
            return ProviderPromptResult.model_validate({"text_by_layer": text_by_layer})
        except ProviderInvalidOutput:
            raise
        except Exception as error:
            raise ProviderInvalidOutput() from error
