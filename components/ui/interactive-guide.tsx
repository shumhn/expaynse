"use client"

import { useState, useEffect, useCallback, useSyncExternalStore } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X,
  ArrowRight,
  ArrowLeft,
  CheckCircle,
  Sparkles,
} from 'lucide-react';

const DEFAULT_GUIDE_STORAGE_PREFIX = 'expaynse-guide';
const GUIDE_STORAGE_EVENT = 'expaynse-guide-storage-change';

function notifyGuideStorageChange(key: string) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(GUIDE_STORAGE_EVENT, { detail: key }));
}

export interface GuideStep {
  id: string;
  target: string;
  title: string;
  description: string;
  position: 'top' | 'bottom' | 'left' | 'right';
}

interface InteractiveGuideProps {
  steps: GuideStep[];
  isOpen: boolean;
  onClose: () => void;
  onComplete: () => void;
  storageKeyPrefix?: string;
  storageScopeKey?: string;
  persistCompletion?: boolean;
}

function buildGuideStorageKey(
  prefix: string,
  suffix: "completed" | "step",
  scopeKey?: string,
) {
  if (scopeKey && scopeKey.trim().length > 0) {
    return `${prefix}-${scopeKey}-${suffix}`;
  }
  return `${prefix}-${suffix}`;
}

export function InteractiveGuide({
  steps,
  isOpen,
  onClose,
  onComplete,
  storageKeyPrefix = DEFAULT_GUIDE_STORAGE_PREFIX,
  storageScopeKey,
  persistCompletion = true,
}: InteractiveGuideProps) {
  const completionKey = buildGuideStorageKey(
    storageKeyPrefix,
    "completed",
    storageScopeKey,
  );
  const stepKey = buildGuideStorageKey(storageKeyPrefix, "step", storageScopeKey);
  const [currentStep, setCurrentStep] = useState(() => {
    if (typeof window === 'undefined') return 0;
    const savedStep = window.localStorage.getItem(stepKey);
    if (!savedStep) return 0;
    const parsed = parseInt(savedStep, 10);
    return Number.isNaN(parsed) || parsed < 0 ? 0 : parsed;
  });
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState({ x: 0, y: 0 });

  const step = steps[currentStep];
  const progress = ((currentStep + 1) / steps.length) * 100;

  const updateTargetPosition = useCallback(() => {
    if (!step) return;
    const element = document.querySelector(step.target);
    if (element) {
      const rect = element.getBoundingClientRect();
      setTargetRect(rect);

      let x = 0, y = 0;
      const tooltipWidth = 320;
      const tooltipHeight = 180;
      const offset = 16;

      switch (step.position) {
        case 'bottom':
          x = rect.left + rect.width / 2 - tooltipWidth / 2;
          y = rect.bottom + offset;
          break;
        case 'top':
          x = rect.left + rect.width / 2 - tooltipWidth / 2;
          y = rect.top - tooltipHeight - offset;
          break;
        case 'left':
          x = rect.left - tooltipWidth - offset;
          y = rect.top + rect.height / 2 - tooltipHeight / 2;
          break;
        case 'right':
          x = rect.right + offset;
          y = rect.top + rect.height / 2 - tooltipHeight / 2;
          break;
      }

      x = Math.max(16, Math.min(x, window.innerWidth - tooltipWidth - 16));
      y = Math.max(16, Math.min(y, window.innerHeight - tooltipHeight - 16));

      setTooltipPosition({ x, y });
    }
  }, [step]);

  useEffect(() => {
    if (isOpen) {
      const frame = window.requestAnimationFrame(updateTargetPosition);
      window.addEventListener('resize', updateTargetPosition);
      window.addEventListener('scroll', updateTargetPosition);
      localStorage.setItem(stepKey, currentStep.toString());
      return () => {
        window.cancelAnimationFrame(frame);
        window.removeEventListener('resize', updateTargetPosition);
        window.removeEventListener('scroll', updateTargetPosition);
      };
    }
  }, [isOpen, currentStep, stepKey, updateTargetPosition]);

  const handleNext = () => {
    if (currentStep < steps.length - 1) {
      setCurrentStep(currentStep + 1);
    } else {
      handleComplete();
    }
  };

  const handlePrev = () => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1);
    }
  };

  const handleComplete = () => {
    if (persistCompletion) {
      localStorage.setItem(completionKey, 'true');
    }
    localStorage.removeItem(stepKey);
    setCurrentStep(0);
    if (persistCompletion) {
      notifyGuideStorageChange(completionKey);
    }
    onComplete();
    onClose();
  };

  const handleSkip = () => {
    if (persistCompletion) {
      localStorage.setItem(completionKey, 'true');
    }
    localStorage.removeItem(stepKey);
    setCurrentStep(0);
    if (persistCompletion) {
      notifyGuideStorageChange(completionKey);
    }
    onClose();
  };

  if (!isOpen || !step) return null;

  return (
    <AnimatePresence>
      <motion.div
        key={`overlay-${step.id}`}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.12, ease: 'easeOut' }}
        className="fixed inset-0 z-[100]"
        style={{
          background: targetRect
            ? `radial-gradient(circle at ${targetRect.left + targetRect.width / 2}px ${
                targetRect.top + targetRect.height / 2
              }px, transparent ${Math.max(targetRect.width, targetRect.height) / 2 + 20}px, rgba(0,0,0,0.72) ${
                Math.max(targetRect.width, targetRect.height) / 2 + 64
              }px)`
            : 'rgba(0,0,0,0.72)',
        }}
        onClick={handleSkip}
      />

      {targetRect && (
        <motion.div
          key={`ring-${step.id}`}
          initial={{ opacity: 0, scale: 0.88 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.88 }}
          transition={{ duration: 0.14, ease: 'easeOut' }}
          className="fixed z-[101] pointer-events-none"
          style={{
            left: targetRect.left - 8,
            top: targetRect.top - 8,
            width: targetRect.width + 16,
            height: targetRect.height + 16,
            borderRadius: 14,
            border: '2px solid rgba(30, 186, 152, 0.95)',
            boxShadow:
              '0 0 0 4px rgba(30, 186, 152, 0.16), 0 0 24px rgba(30, 186, 152, 0.24)',
          }}
        >
          <motion.div
            animate={{
              scale: [1, 1.04, 1],
              opacity: [0.5, 0.15, 0.5],
            }}
            transition={{
              duration: 2,
              repeat: Infinity,
              ease: 'easeInOut',
            }}
            className="absolute inset-0 rounded-[12px] border-2 border-[#1eba98]"
          />
        </motion.div>
      )}

      <motion.div
        key={`tooltip-${step.id}`}
        initial={{ opacity: 0, scale: 0.9, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.9, y: 10 }}
        transition={{ type: 'spring', damping: 28, stiffness: 420, mass: 0.7 }}
        className="fixed z-[102] w-80 bg-white rounded-2xl shadow-2xl border border-gray-200 overflow-hidden"
        style={{
          left: tooltipPosition.x,
          top: tooltipPosition.y,
        }}
        onClick={(event) => event.stopPropagation()}
      >
          <div className="flex items-center justify-between px-5 pt-5 pb-3">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-emerald-500" />
              <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">
                Step {currentStep + 1} of {steps.length}
              </span>
            </div>
            <button
              onClick={handleSkip}
              className="p-1 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <X className="w-4 h-4 text-gray-400" />
            </button>
          </div>

          <div className="mx-5 h-1 bg-gray-100 rounded-full overflow-hidden">
            <motion.div
              className="h-full bg-emerald-400 rounded-full"
              initial={{ width: 0 }}
              animate={{ width: `${progress}%` }}
              transition={{ duration: 0.3 }}
            />
          </div>

          <div className="px-5 py-4">
            <h3 className="text-lg font-semibold text-gray-900 mb-2">
              {step.title}
            </h3>
            <p className="text-sm text-gray-600 leading-relaxed">
              {step.description}
            </p>
          </div>

          <div className="flex items-center justify-between px-5 pb-5">
            <button
              onClick={handleSkip}
              className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
            >
              Skip tour
            </button>
            <div className="flex items-center gap-2">
              {currentStep > 0 && (
                <button
                  onClick={handlePrev}
                  className="flex items-center gap-1 px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                >
                  <ArrowLeft className="w-4 h-4" />
                  Back
                </button>
              )}
              <button
                onClick={handleNext}
                className="flex items-center gap-1 px-4 py-2 bg-black text-white text-sm font-medium rounded-lg hover:bg-gray-800 transition-colors"
              >
                {currentStep === steps.length - 1 ? (
                  <>
                    <CheckCircle className="w-4 h-4" />
                    Done
                  </>
                ) : (
                  <>
                    Next
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>
            </div>
          </div>
        </motion.div>
    </AnimatePresence>
  );
}

export function useGuideStatus(
  storageKeyPrefix = DEFAULT_GUIDE_STORAGE_PREFIX,
  storageScopeKey?: string,
) {
  const completionKey = buildGuideStorageKey(
    storageKeyPrefix,
    "completed",
    storageScopeKey,
  );
  const stepKey = buildGuideStorageKey(storageKeyPrefix, "step", storageScopeKey);
  const hasCompleted = useSyncExternalStore(
    (onStoreChange) => {
      if (typeof window === 'undefined') {
        return () => {};
      }

      const onStorage = (event: StorageEvent) => {
        if (!event.key || event.key === completionKey) {
          onStoreChange();
        }
      };

      const onGuideStorage = (event: Event) => {
        const customEvent = event as CustomEvent<string>;
        if (!customEvent.detail || customEvent.detail === completionKey) {
          onStoreChange();
        }
      };

      window.addEventListener('storage', onStorage);
      window.addEventListener(GUIDE_STORAGE_EVENT, onGuideStorage as EventListener);
      return () => {
        window.removeEventListener('storage', onStorage);
        window.removeEventListener(GUIDE_STORAGE_EVENT, onGuideStorage as EventListener);
      };
    },
    () => {
      if (typeof window === 'undefined') return false;
      return !!window.localStorage.getItem(completionKey);
    },
    () => false,
  );

  const resetGuide = () => {
    localStorage.removeItem(completionKey);
    localStorage.removeItem(stepKey);
    notifyGuideStorageChange(completionKey);
  };

  return { hasCompleted, resetGuide };
}
