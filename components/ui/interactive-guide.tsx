"use client"

import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X,
  ArrowRight,
  ArrowLeft,
  CheckCircle,
  Sparkles,
} from 'lucide-react';

const GUIDE_STORAGE_KEY = 'expaynse-guide-completed';
const GUIDE_STEP_KEY = 'expaynse-guide-step';

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
}

export function InteractiveGuide({ steps, isOpen, onClose, onComplete }: InteractiveGuideProps) {
  const [currentStep, setCurrentStep] = useState(0);
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
      updateTargetPosition();
      window.addEventListener('resize', updateTargetPosition);
      window.addEventListener('scroll', updateTargetPosition);
      localStorage.setItem(GUIDE_STEP_KEY, currentStep.toString());
      return () => {
        window.removeEventListener('resize', updateTargetPosition);
        window.removeEventListener('scroll', updateTargetPosition);
      };
    }
  }, [isOpen, currentStep, updateTargetPosition]);

  useEffect(() => {
    const savedStep = localStorage.getItem(GUIDE_STEP_KEY);
    if (savedStep) {
      const parsed = parseInt(savedStep, 10);
      if (!isNaN(parsed) && parsed < steps.length) {
        setCurrentStep(parsed);
      }
    }
  }, [steps.length]);

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
    localStorage.setItem(GUIDE_STORAGE_KEY, 'true');
    localStorage.removeItem(GUIDE_STEP_KEY);
    onComplete();
  };

  const handleSkip = () => {
    localStorage.setItem(GUIDE_STORAGE_KEY, 'true');
    localStorage.removeItem(GUIDE_STEP_KEY);
    onClose();
  };

  if (!isOpen || !step) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-100"
      >
        {/* Dark overlay with spotlight */}
        <div className="absolute inset-0 bg-black/60" />

        {/* Spotlight around target */}
        {targetRect && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="absolute pointer-events-none"
            style={{
              left: targetRect.left - 8,
              top: targetRect.top - 8,
              width: targetRect.width + 16,
              height: targetRect.height + 16,
              boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.6)',
              borderRadius: '12px',
            }}
          />
        )}

        {/* Tooltip */}
        <motion.div
          initial={{ opacity: 0, scale: 0.9, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.9, y: 10 }}
          transition={{ type: 'spring', damping: 25, stiffness: 300 }}
          className="absolute z-101 w-80 bg-white rounded-2xl shadow-2xl border border-gray-200 overflow-hidden"
          style={{
            left: tooltipPosition.x,
            top: tooltipPosition.y,
          }}
        >
          {/* Header */}
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

          {/* Progress bar */}
          <div className="mx-5 h-1 bg-gray-100 rounded-full overflow-hidden">
            <motion.div
              className="h-full bg-emerald-400 rounded-full"
              initial={{ width: 0 }}
              animate={{ width: `${progress}%` }}
              transition={{ duration: 0.3 }}
            />
          </div>

          {/* Content */}
          <div className="px-5 py-4">
            <h3 className="text-lg font-semibold text-gray-900 mb-2">
              {step.title}
            </h3>
            <p className="text-sm text-gray-600 leading-relaxed">
              {step.description}
            </p>
          </div>

          {/* Actions */}
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
      </motion.div>
    </AnimatePresence>
  );
}

export function useGuideStatus() {
  const [hasCompleted, setHasCompleted] = useState(true);

  useEffect(() => {
    const completed = localStorage.getItem(GUIDE_STORAGE_KEY);
    setHasCompleted(!!completed);
  }, []);

  const resetGuide = () => {
    localStorage.removeItem(GUIDE_STORAGE_KEY);
    localStorage.removeItem(GUIDE_STEP_KEY);
    setHasCompleted(false);
  };

  return { hasCompleted, resetGuide };
}
