import { useState, useEffect } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/Tooltip';
import { fetchCanonicalModelInfo, type CanonicalModelInfo } from '../../utils/canonical';
import { defineMessages, useIntl } from '../../i18n';
import {
  DEFAULT_KERNEL_CURRENCY,
  estimateKernelCost,
  formatKernelCost,
  type KernelPrices,
} from '../../utils/kernelCost';
import { defaultSettings } from '../../utils/settings';

const i18n = defineMessages({
  pricingUnavailable: {
    id: 'costTracker.pricingUnavailable',
    defaultMessage: 'Pricing data unavailable for {model}',
  },
  costUnavailable: {
    id: 'costTracker.costUnavailable',
    defaultMessage:
      'Cost data not available for {model} ({inputTokens} input, {outputTokens} output tokens)',
  },
  totalSessionCost: {
    id: 'costTracker.totalSessionCost',
    defaultMessage: 'Total session cost: {cost}',
  },
  inputOutputTooltip: {
    id: 'costTracker.inputOutputTooltip',
    defaultMessage:
      'Input: {inputTokens} tokens ({inputCost}) | Output: {outputTokens} tokens ({outputCost})',
  },
  kernelEstimate: {
    id: 'costTracker.kernelEstimate',
    defaultMessage: 'Estimated from your prices',
  },
  kernelEstimateTooltip: {
    id: 'costTracker.kernelEstimateTooltip',
    defaultMessage:
      'Served by {model} through the {kernel} kernel. Estimated from the prices you entered in Settings → App → Agent kernel · input {inputTokens} tok, output {outputTokens} tok.',
  },
  kernelPricesMissing: {
    id: 'costTracker.kernelPricesMissing',
    defaultMessage:
      'The kernel is serving your model {model}, so goose has no price for it. Enter the per-million-token prices in Settings → App → Agent kernel to see a cost estimate.',
  },
});

interface CostTrackerProps {
  inputTokens?: number;
  outputTokens?: number;
  accumulatedCost?: number | null;
  model: string | null;
  provider: string | null;
}

export function CostTracker({
  inputTokens = 0,
  outputTokens = 0,
  accumulatedCost,
  model: currentModel,
  provider: currentProvider,
}: CostTrackerProps) {
  const intl = useIntl();
  const [costInfo, setCostInfo] = useState<CanonicalModelInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [showPricing, setShowPricing] = useState(true);
  const [pricingFailed, setPricingFailed] = useState(false);
  /** Set while an external kernel serves the request: then the user's own prices apply. */
  const [kernel, setKernel] = useState<(KernelPrices & { model: string; runtime: string }) | null>(
    null
  );

  useEffect(() => {
    const statusPromise = window.electron.getAgentKernelStatus?.();
    if (!statusPromise) {
      return;
    }
    Promise.all([statusPromise, window.electron.getSetting('agentKernel')])
      .then(([status, settings]) => {
        if (status.runtime === 'builtin') {
          setKernel(null);
          return;
        }
        const stored = settings ?? defaultSettings.agentKernel;
        setKernel({
          model: status.model || stored.model,
          runtime: status.runtime,
          inputTokenCost: stored.inputTokenCost ?? null,
          outputTokenCost: stored.outputTokenCost ?? null,
          currency: stored.currency ?? '',
        });
      })
      .catch(() => setKernel(null));
  }, []);

  // Check if pricing is enabled
  useEffect(() => {
    const loadPricingSetting = async () => {
      const enabled = await window.electron.getSetting('showPricing');
      setShowPricing(enabled);
    };

    loadPricingSetting();

    const handlePricingChange = () => {
      loadPricingSetting();
    };

    window.addEventListener('showPricingChanged', handlePricingChange);
    return () => window.removeEventListener('showPricingChanged', handlePricingChange);
  }, []);

  useEffect(() => {
    const loadCostInfo = async () => {
      if (!currentModel || !currentProvider) {
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      try {
        const costData = await fetchCanonicalModelInfo(currentProvider, currentModel);
        if (costData) {
          setCostInfo(costData);
          setPricingFailed(false);
        } else {
          setPricingFailed(true);
          setCostInfo(null);
        }
      } catch {
        setPricingFailed(true);
        setCostInfo(null);
      } finally {
        setIsLoading(false);
      }
    };

    loadCostInfo();
  }, [currentModel, currentProvider]);

  // Return null early if pricing is disabled
  if (!showPricing) {
    return null;
  }

  const calculateCost = (): number => {
    return accumulatedCost ?? 0;
  };

  const formatCost = (cost: number): string => cost.toFixed(2);

  // Show loading state or when we don't have model/provider info
  if (!currentModel || !currentProvider) {
    return null;
  }

  // If still loading, show a placeholder
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-text-secondary translate-y-[1px]">
        <span className="text-xs font-mono">...</span>
      </div>
    );
  }

  const currency = costInfo?.currency || '$';

  // An external kernel names its own model ("current"), so goose cannot price the session.
  // Price the kernel's reported tokens with the user's own prices instead.
  if (kernel) {
    const estimate = estimateKernelCost(inputTokens, outputTokens, kernel);
    const kernelCurrency = kernel.currency || DEFAULT_KERNEL_CURRENCY;
    const kernelName = kernel.runtime === 'codex' ? 'Codex' : 'Claude Code';

    if (estimate === null) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center justify-center h-full transition-colors cursor-default translate-y-[1px] text-text-primary/70 hover:text-text-primary">
              <span className="text-xs font-mono">
                {inputTokens.toLocaleString()}↑ {outputTokens.toLocaleString()}↓
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent>
            {intl.formatMessage(i18n.kernelPricesMissing, { model: kernel.model })}
          </TooltipContent>
        </Tooltip>
      );
    }

    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center justify-center h-full transition-colors cursor-default translate-y-[1px] text-text-primary/70 hover:text-text-primary">
            <span className="text-xs font-mono">
              ≈ {formatKernelCost(estimate, kernelCurrency)}
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent>
          {`${intl.formatMessage(i18n.kernelEstimate)} · ${intl.formatMessage(
            i18n.kernelEstimateTooltip,
            {
              model: kernel.model,
              kernel: kernelName,
              inputTokens: inputTokens.toLocaleString(),
              outputTokens: outputTokens.toLocaleString(),
            }
          )}`}
        </TooltipContent>
      </Tooltip>
    );
  }

  if (
    accumulatedCost == null &&
    (!costInfo || (costInfo.inputTokenCost === undefined && costInfo.outputTokenCost === undefined))
  ) {
    const freeProviders = ['ollama', 'local', 'localhost'];
    if (freeProviders.includes(currentProvider.toLowerCase())) {
      return (
        <div className="flex items-center justify-center h-full text-text-primary/70 transition-colors cursor-default translate-y-[1px]">
          <span className="text-xs font-mono">
            {inputTokens.toLocaleString()}↑ {outputTokens.toLocaleString()}↓
          </span>
        </div>
      );
    }

    // Otherwise show as unavailable
    const getUnavailableTooltip = () => {
      if (pricingFailed) {
        return intl.formatMessage(i18n.pricingUnavailable, { model: currentModel });
      }
      return intl.formatMessage(i18n.costUnavailable, {
        model: currentModel,
        inputTokens: inputTokens.toLocaleString(),
        outputTokens: outputTokens.toLocaleString(),
      });
    };

    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center justify-center h-full transition-colors cursor-default translate-y-[1px] text-text-primary/70 hover:text-text-primary">
            <span className="text-xs font-mono">
              {currency}
              {formatCost(0)}
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent>{getUnavailableTooltip()}</TooltipContent>
      </Tooltip>
    );
  }

  const totalCost = calculateCost();

  // Build tooltip content
  const getTooltipContent = (): string => {
    if (pricingFailed) {
      return intl.formatMessage(i18n.pricingUnavailable, {
        model: `${currentProvider}/${currentModel}`,
      });
    }

    if (accumulatedCost != null) {
      return (
        intl.formatMessage(i18n.totalSessionCost, { cost: `${currency}${totalCost.toFixed(4)}` }) +
        `\n` +
        intl.formatMessage(i18n.inputOutputTooltip, {
          inputTokens: inputTokens.toLocaleString(),
          inputCost: `${currency}${((inputTokens * (costInfo?.inputTokenCost || 0)) / 1_000_000).toFixed(6)}`,
          outputTokens: outputTokens.toLocaleString(),
          outputCost: `${currency}${((outputTokens * (costInfo?.outputTokenCost || 0)) / 1_000_000).toFixed(6)}`,
        })
      );
    }

    const inputCostStr = `${currency}${((inputTokens * (costInfo?.inputTokenCost || 0)) / 1_000_000).toFixed(6)}`;
    const outputCostStr = `${currency}${((outputTokens * (costInfo?.outputTokenCost || 0)) / 1_000_000).toFixed(6)}`;
    return intl.formatMessage(i18n.inputOutputTooltip, {
      inputTokens: inputTokens.toLocaleString(),
      inputCost: inputCostStr,
      outputTokens: outputTokens.toLocaleString(),
      outputCost: outputCostStr,
    });
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center justify-center h-full transition-colors cursor-default translate-y-[1px] text-text-primary/70 hover:text-text-primary">
          <span className="text-xs font-mono">
            {currency}
            {formatCost(totalCost)}
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent>{getTooltipContent()}</TooltipContent>
    </Tooltip>
  );
}
