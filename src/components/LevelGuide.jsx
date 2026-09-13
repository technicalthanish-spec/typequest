import { useEffect, useRef, useState } from "react";
import { LEVEL_GUIDES } from "../data/levelGuides";

export default function LevelGuide({
  level,
  onComplete,
  onSkipAll
}) {
  const steps = LEVEL_GUIDES[level] || [];
  const [stepIndex, setStepIndex] = useState(0);
  const [layout, setLayout] = useState({
    rect: null,
    width: typeof window !== "undefined" ? window.innerWidth : 1200,
    height: typeof window !== "undefined" ? window.innerHeight : 800
  });

  const cardRef = useRef(null);

  const step = steps[stepIndex];

  useEffect(() => {
    setStepIndex(0);
  }, [level]);

  useEffect(() => {
    if (!step) return;

    let timer;

    const updatePosition = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;

      const target = document.getElementById(
        `tour-${step.target}`
      );

      if (!target) {
        setLayout({
          rect: null,
          width,
          height
        });
        return;
      }

      const rect = target.getBoundingClientRect();

      setLayout({
        rect: {
          top: rect.top,
          left: rect.left,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height
        },
        width,
        height
      });
    };

    const target = document.getElementById(
      `tour-${step.target}`
    );

    if (target) {
      const rect = target.getBoundingClientRect();

      const outsideViewport =
        rect.top < 20 ||
        rect.bottom > window.innerHeight - 20;

      if (outsideViewport) {
        target.scrollIntoView({
          behavior: "smooth",
          block: "center"
        });

        timer = setTimeout(updatePosition, 350);
      }
    }

    updatePosition();

    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);

    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [step, stepIndex]);

  useEffect(() => {
    cardRef.current?.focus();
  }, [stepIndex]);

  if (!step || steps.length === 0) return null;

  const isLast = stepIndex === steps.length - 1;
  const rect = layout.rect;

  const cardWidth = Math.min(370, layout.width - 24);

  let cardTop = Math.max(
    12,
    layout.height / 2 - 150
  );

  let cardLeft = Math.max(
    12,
    (layout.width - cardWidth) / 2
  );

  let placement = "center";

  if (rect) {
    const spaceBelow = layout.height - rect.bottom;
    const enoughBelow = spaceBelow > 270;

    placement = enoughBelow ? "below" : "above";

    cardLeft = Math.min(
      Math.max(
        12,
        rect.left + rect.width / 2 - cardWidth / 2
      ),
      layout.width - cardWidth - 12
    );

    if (enoughBelow) {
      cardTop = Math.min(
        rect.bottom + 18,
        layout.height - 220
      );
    } else {
      cardTop = Math.max(
        12,
        rect.top - 245
      );
    }
  }

  const next = () => {
    if (isLast) {
      onComplete?.();
      return;
    }

    setStepIndex(current => current + 1);
  };

  const back = () => {
    setStepIndex(current =>
      Math.max(0, current - 1)
    );
  };

  return (
    <div
      role="presentation"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 99999,
        overflow: "hidden"
      }}
    >
      {/* Dark background when target is unavailable */}
      {!rect && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(5, 8, 18, 0.78)",
            backdropFilter: "blur(2px)"
          }}
        />
      )}

      {/* Highlighted real UI element */}
      {rect && (
        <div
          aria-hidden="true"
          style={{
            position: "fixed",
            top: Math.max(4, rect.top - 6),
            left: Math.max(4, rect.left - 6),
            width: Math.max(20, rect.width + 12),
            height: Math.max(20, rect.height + 12),
            borderRadius: 16,
            border: "2px solid rgba(139, 92, 246, 0.95)",
            boxShadow:
              "0 0 0 9999px rgba(5, 8, 18, 0.78), 0 0 0 5px rgba(139, 92, 246, 0.18), 0 0 32px rgba(139, 92, 246, 0.65)",
            pointerEvents: "none",
            transition:
              "top 180ms ease, left 180ms ease, width 180ms ease, height 180ms ease"
          }}
        />
      )}

      {/* Popup */}
      <section
        ref={cardRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`Level ${level} guide`}
        style={{
          position: "fixed",
          top: cardTop,
          left: cardLeft,
          width: cardWidth,
          maxHeight: "46vh",
          overflowY: "auto",
          padding: "20px",
          borderRadius: "20px",
          background:
            "linear-gradient(145deg, rgba(27, 31, 55, 0.98), rgba(14, 17, 34, 0.98))",
          border: "1px solid rgba(255,255,255,0.12)",
          boxShadow:
            "0 24px 80px rgba(0,0,0,0.48)",
          color: "#fff",
          outline: "none",
          zIndex: 100001
        }}
      >
        {/* Arrow */}
        {rect && placement === "below" && (
          <div
            aria-hidden="true"
            style={{
              position: "absolute",
              top: -14,
              left: "50%",
              transform: "translateX(-50%)",
              fontSize: 22
            }}
          >
            ▲
          </div>
        )}

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 12,
            marginBottom: 14
          }}
        >
          <span
            style={{
              fontSize: 11,
              fontWeight: 800,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              opacity: 0.72
            }}
          >
            Level {level} Guide
          </span>

          <span
            style={{
              padding: "5px 9px",
              borderRadius: 999,
              background: "rgba(139,92,246,0.16)",
              fontSize: 12,
              fontWeight: 700
            }}
          >
            {stepIndex + 1} / {steps.length}
          </span>
        </div>

        <h2
          style={{
            margin: "0 0 8px",
            fontSize: "clamp(20px, 4vw, 26px)",
            lineHeight: 1.15
          }}
        >
          {step.title}
        </h2>

        <p
          style={{
            margin: 0,
            lineHeight: 1.55,
            color: "rgba(255,255,255,0.76)",
            fontSize: 14
          }}
        >
          {step.text}
        </p>

        {/* Progress dots */}
        {steps.length > 1 && (
          <div
            style={{
              display: "flex",
              gap: 6,
              marginTop: 18
            }}
          >
            {steps.map((_, index) => (
              <span
                key={index}
                aria-hidden="true"
                style={{
                  width: index === stepIndex ? 22 : 7,
                  height: 7,
                  borderRadius: 999,
                  background:
                    index === stepIndex
                      ? "#a78bfa"
                      : "rgba(255,255,255,0.2)",
                  transition: "all 160ms ease"
                }}
              />
            ))}
          </div>
        )}

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 8,
            marginTop: 20
          }}
        >
          {stepIndex > 0 && (
            <button
              type="button"
              onClick={back}
              style={secondaryButton}
            >
              ← Back
            </button>
          )}

          {onSkipAll && (
            <button
              type="button"
              onClick={onSkipAll}
              style={{
                ...secondaryButton,
                marginRight: "auto"
              }}
            >
              Skip all tips
            </button>
          )}

          <button
            type="button"
            onClick={next}
            style={primaryButton}
          >
            {isLast ? "Got it ✓" : "Next →"}
          </button>
        </div>

        {rect && placement === "above" && (
          <div
            aria-hidden="true"
            style={{
              textAlign: "center",
              marginTop: 8,
              marginBottom: -14,
              fontSize: 22
            }}
          >
            ▼
          </div>
        )}
      </section>
    </div>
  );
}

const primaryButton = {
  border: 0,
  borderRadius: 12,
  padding: "11px 16px",
  background:
    "linear-gradient(135deg, #8b5cf6, #6366f1)",
  color: "#fff",
  fontWeight: 800,
  cursor: "pointer",
  fontSize: 14,
  boxShadow: "0 8px 24px rgba(99,102,241,0.28)"
};

const secondaryButton = {
  border: "1px solid rgba(255,255,255,0.14)",
  borderRadius: 12,
  padding: "10px 13px",
  background: "rgba(255,255,255,0.05)",
  color: "rgba(255,255,255,0.82)",
  fontWeight: 700,
  cursor: "pointer",
  fontSize: 13
};
